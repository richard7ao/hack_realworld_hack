"""Jev-assisted frontier manipulation. Guidance is input, never a motion override."""
from __future__ import annotations

import hashlib
import json
import asyncio

from . import jev

ASSISTED_MODELS = {"jev_gpt-6.1-sol": "gpt-6.1-sol", "jev_gpt-6-astra": "gpt-6-astra",
                   "jev_claude-opus-5-5": "claude-opus-5-5"}


class JevAssistedPolicy:
    def __init__(self, policy_id):
        from .policies import FrontierPlanner
        if policy_id not in ASSISTED_MODELS:
            raise ValueError("Unknown Jev-assisted frontier policy")
        if not jev.available():
            raise ValueError("Jev-assisted policy requires JEV_API_KEY or TYPESAFE_API_KEY")
        self.frontier = FrontierPlanner(ASSISTED_MODELS[policy_id])
        base = self.frontier.manifest
        self.manifest = base.model_copy(update={"policy_id": policy_id, "version": "symbolic_jev_manipulation_v1",
            "prompt_hash": hashlib.sha256((base.prompt_hash + jev.MANIPULATION_GUIDANCE_VERSION).encode()).hexdigest(),
            "parameters": {**base.parameters, "jev_model": jev.JEV_MODEL, "jev_guidance_version": jev.MANIPULATION_GUIDANCE_VERSION,
                "underlying_policy_id": ASSISTED_MODELS[policy_id], "underlying_prompt_hash": base.prompt_hash,
                "model_call_counting": "jev_and_frontier_attempts", "guidance_authority": "advisory_frontier_input_only"}})
        self.jev_calls, self.inference_record, self.last_action = 0, None, None

    @property
    def calls(self):
        return self.jev_calls + self.frontier.calls

    def reset(self, task, capabilities, version=None):
        self.frontier.reset(task, capabilities, version)
        self.frontier.calls, self.frontier.inference_record = 0, None
        self.capabilities = capabilities
        self.jev_calls, self.inference_record, self.last_action = 0, None, None

    async def predict(self, observation):
        self.inference_record = None
        self.jev_calls += 1
        guidance = await asyncio.wait_for(jev.advise_manipulation(observation, self.last_action, self.capabilities), timeout=8)
        forwarded = observation.model_copy(deep=True)
        # Native renderer metadata includes full initial object poses; keep only
        # proprioceptive native feedback in the forwarded policy observation.
        if forwarded.robot.native_physics:
            forwarded.robot.native_physics = {k: v for k, v in forwarded.robot.native_physics.items() if k != "initial_objects"}
        details = dict(forwarded.last_action_result.details)
        if isinstance(details.get("native_physics"), dict):
            details["native_physics"] = {k: v for k, v in details["native_physics"].items() if k != "initial_objects"}
        details["jev_guidance"] = {"model": guidance["response_model"], "guidance_version": guidance["guidance_version"],
            "observed_at_step": guidance["scope"]["observed_at_step"], "cause": guidance["answers"]["cause"],
            "recommended_intent": guidance["answers"]["recommended_intent"], "unsafe_to_repeat": guidance["answers"]["unsafe_to_repeat"],
            "instruction": "Advisory manipulation guidance; use current observations, choose your own typed action, and obey executor capabilities. This is not a success verdict."}
        forwarded.last_action_result.details = details
        # If the frontier transport fails, keep the completed guidance available
        # to callers; the runner still records an explicit policy failure.
        self.inference_record = {"jev_assistance": guidance, "model_call_counts": {"jev": self.jev_calls, "frontier": self.frontier.calls}}
        self.frontier.inference_record = None
        try:
            action = await self.frontier.predict(forwarded)
        finally:
            self.inference_record = {**(self.frontier.inference_record or {}), "jev_assistance": guidance,
                "model_call_counts": {"jev": self.jev_calls, "frontier": self.frontier.calls},
                "guidance_forwarded_sha256": hashlib.sha256(json.dumps(details["jev_guidance"], sort_keys=True).encode()).hexdigest()}
        self.last_action = action.model_dump(mode="json")
        return action
