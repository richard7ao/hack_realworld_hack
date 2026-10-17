"""Policies propose typed actions. They never receive world or evaluator access."""
from __future__ import annotations

import hashlib
import json
import math
import os
from typing import Protocol

import httpx
from dotenv import load_dotenv

from .models import PolicyAction, PolicyManifest, PolicyObservation
from .kinematics import ArmConfig, KinematicsError, inverse_kinematics, joint_path, segment_intersects_box


class PolicyAdapter(Protocol):
    manifest: PolicyManifest
    def reset(self, task, capabilities, version=None): ...
    async def predict(self, observation: PolicyObservation) -> PolicyAction: ...


class ScriptedPolicy:
    def __init__(self, reobserve=False):
        self.reobserve = reobserve
        self.manifest = PolicyManifest(policy_id="scripted_reobserve" if reobserve else "scripted_open_loop",
                                       version="1.0.0", adapter_type="scripted")
        self.phase = "approach"
        self.calls = 0
        self.inference_record = None

    def reset(self, task, capabilities, version=None):
        self.phase = "approach"
        self.task = task
        self.capabilities = capabilities

    async def predict(self, obs):
        target = next((o for o in obs.detected_objects if o.id == obs.task.target_id), None)
        if obs.last_action_result.status == "rejected":
            if not self.reobserve:
                return PolicyAction(type="DONE", reason="Open-loop plan invalidated; stop and preserve failure")
            if self.phase != "after_error":
                self.phase = "after_error"
                return PolicyAction(type="OBSERVE", reason="Rejected action; obtain a fresh estimate")
        if self.phase == "after_error":
            self.phase = "travel" if obs.robot.holding_id else "approach"
        if target is None or not target.visible or target.confidence < 0.6:
            return PolicyAction(type="REQUEST_HELP", reason="Target cannot be confidently localized")
        if self.phase == "approach":
            self.phase = "verify" if self.reobserve else "grasp"
            return PolicyAction(type="MOVE_TO", target_id=target.id, position=target.position, reason="Approach last observed target")
        if self.phase == "verify":
            self.phase = "approach_fresh"
            return PolicyAction(type="OBSERVE", reason="Check target again before closing gripper")
        if self.phase == "approach_fresh":
            self.phase = "grasp"
            return PolicyAction(type="MOVE_TO", target_id=target.id, position=target.position, reason="Approach refreshed estimate")
        if self.phase == "grasp":
            self.phase = "lift"
            return PolicyAction(type="GRASP", target_id=target.id, position=target.position, reason="Close at estimated target pose")
        if self.phase == "lift":
            self.phase = "travel"
            return PolicyAction(type="MOVE_TO", position=(*obs.robot.position[:2], 0.25), reason="Lift to travel height")
        if self.phase == "travel":
            self.phase = "lower"
            return PolicyAction(type="MOVE_TO", position=(*obs.destination.center[:2], 0.25), reason="Travel above outbound bin")
        if self.phase == "lower":
            self.phase = "place"
            return PolicyAction(type="MOVE_TO", position=obs.destination.center, reason="Lower to observed destination")
        if self.phase == "place":
            self.phase = "done"
            return PolicyAction(type="PLACE", target_id=obs.task.destination_id, reason="Release; evaluator verifies placement")
        return PolicyAction(type="DONE", reason="Sequence complete; request independent evaluation")


class ObstacleAwarePolicy:
    """Bounded deterministic waypoint search using only permitted observations.

    The public kinematic model and observed obstacles can be used to validate
    proposed routes. No simulator instance, hidden object state or future event
    schedule is available to this adapter.
    """
    def __init__(self):
        self.manifest = PolicyManifest(policy_id="scripted_obstacle_aware", version="warehouse_waypoints_v1",
            adapter_type="scripted", parameters={"planner": "bounded_deterministic_waypoint_search"})
        self.calls, self.inference_record = 0, None

    def reset(self, task, capabilities, version=None):
        self.capabilities, self.task = capabilities, task
        self.phase, self.pending = "approach", []
        self.config = ArmConfig.from_dict(capabilities["robot_config"]) if "robot_config" in capabilities else None

    def _route(self, obs, goal):
        start = obs.robot.position
        heights = sorted({self.capabilities.get("safe_travel_height", .25),
                          min(self.capabilities.get("max_height", .5) - .1, 1.8),
                          min(self.capabilities.get("max_height", .5) - .1, 2.1)})
        candidates = [[goal]]
        width, depth = obs.workspace
        for height in heights:
            upper_start, upper_goal = (*start[:2], height), (*goal[:2], height)
            candidates.append([upper_start, upper_goal, goal])
            for x in [width * .25, width * .5, width * .75]:
                candidates.append([upper_start, (x, start[1], height), (x, goal[1], height), upper_goal, goal])
            for y in [depth * .25, depth * .5, depth * .75]:
                candidates.append([upper_start, (start[0], y, height), (goal[0], y, height), upper_goal, goal])
        attempts = 0
        for candidate in candidates:
            attempts += 1
            current_position, current_angles = start, obs.robot.joint_angles
            valid, path = True, []
            for point in candidate:
                if math.dist(current_position, point) < 1e-7:
                    continue
                try:
                    if self.config:
                        ik = inverse_kinematics(point, self.config, current_angles)
                        held = next((o for o in obs.detected_objects if o.id == obs.robot.holding_id), None)
                        carried = None
                        if held:
                            c, s = abs(math.cos(held.yaw_rad)), abs(math.sin(held.yaw_rad))
                            carried = (c * held.dimensions[0] + s * held.dimensions[1],
                                       s * held.dimensions[0] + c * held.dimensions[1], held.dimensions[2])
                        joint_path(current_angles, ik["joint_angles"], self.config, obs.observed_obstacles,
                                   carried_dimensions=carried)
                        current_angles = ik["joint_angles"]
                    else:
                        if any(segment_intersects_box(current_position, point, obstacle, .03) for obstacle in obs.observed_obstacles):
                            raise KinematicsError("PATH_OBSTRUCTED")
                    if obs.robot.holding_id:
                        held = next((o for o in obs.detected_objects if o.id == obs.robot.holding_id), None)
                        padding = tuple(max(.03, d / 2) for d in held.dimensions) if held else .05
                        if any(segment_intersects_box(current_position, point, obstacle, padding) for obstacle in obs.observed_obstacles):
                            raise KinematicsError("PATH_OBSTRUCTED")
                    path.append(tuple(point))
                    current_position = point
                except KinematicsError:
                    valid = False
                    break
            if valid:
                self.inference_record = {"planner": "bounded_deterministic_waypoint_search", "routes_checked": attempts,
                    "waypoints": path, "observed_obstacle_ids": [z.id for z in obs.observed_obstacles],
                    "kinematic_link_checks": self.config is not None}
                return [PolicyAction(type="MOVE_TO", position=p, max_execution_ms=10000,
                    reason="Follow route validated against observed obstacle geometry") for p in path]
        self.inference_record = {"planner": "bounded_deterministic_waypoint_search", "routes_checked": attempts,
            "waypoints": None, "observed_obstacle_ids": [z.id for z in obs.observed_obstacles]}
        return None

    async def predict(self, obs):
        target = next((o for o in obs.detected_objects if o.id == obs.task.target_id), None)
        if obs.last_action_result.status == "rejected":
            self.pending = []
            if obs.last_action_result.reason in ("TARGET_DISPLACED", "STALE_OBSERVATION", "DESTINATION_CHANGED"):
                self.phase = "carry" if obs.robot.holding_id else "approach"
                return PolicyAction(type="OBSERVE", reason="Refresh observations after a stale plan was rejected")
            return PolicyAction(type="REQUEST_HELP", reason="Executor rejected the proposed route; stop for review")
        if not target or not target.visible or target.confidence < .6:
            return PolicyAction(type="REQUEST_HELP", reason="Target localization is uncertain")
        if self.pending:
            return self.pending.pop(0)
        if self.phase == "approach":
            moves = self._route(obs, target.position)
            if moves is None:
                return PolicyAction(type="REQUEST_HELP", reason="No collision-free route found by the bounded planner")
            self.phase, self.pending = "verify", moves
            if self.pending:
                return self.pending.pop(0)
        if self.phase == "verify":
            self.phase = "grasp"
            return PolicyAction(type="OBSERVE", reason="Reobserve the target before grasp")
        if self.phase == "grasp":
            if math.dist(obs.robot.position, target.position) > .025:
                self.phase = "approach"
                return await self.predict(obs)
            self.phase = "carry"
            return PolicyAction(type="GRASP", target_id=target.id, position=target.position,
                                reason="Grasp at the refreshed target estimate")
        if self.phase == "carry":
            moves = self._route(obs, obs.destination.center)
            if moves is None:
                return PolicyAction(type="REQUEST_HELP", reason="No collision-free delivery route found")
            self.phase, self.pending = "place", moves
            if self.pending:
                return self.pending.pop(0)
        if self.phase == "place":
            self.phase = "done"
            return PolicyAction(type="PLACE", target_id=obs.task.destination_id, reason="Release for independent verification")
        return PolicyAction(type="DONE", reason="Finish; independent oracle determines the outcome")


PROMPT = """You control a simulated Cartesian gripper for a warehouse pick-and-place test.
Return one permitted symbolic action. You receive only sampled object estimates and robot feedback.
Coordinates are in the observation's declared frame. There is no physical robot. You do not decide success.
MOVE_TO needs position [x,y,z]; GRASP needs target_id and its observed position and requires gripper at that pose.
The target can move. OBSERVE refreshes positions, visibility, destination and obstacles; robot feedback is current.
Use capabilities.safe_travel_height (default z=0.25) before carrying, travel above destination, lower to destination.center, then PLACE with destination id.
Avoid observed obstacles (axis-aligned boxes). Re-observe before grasp and after a rejected action.
If target is invisible/uncertain, request help. Never grasp a different ID. DONE ends evaluation and cannot assert a pass.
Stay inside workspace XY and z in [0,capabilities.max_height] (default maximum 0.5).
An optional six-revolute-joint arm uses deterministic IK and validates all arm links along its joint trajectory.
Kinematic reach, joint limits and obstacle collisions can reject an endpoint that appears inside the workspace.
Work within the action budget. Keep reason a short operational explanation.
"""

ACTION_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "type": {"type": "string", "enum": ["OBSERVE", "MOVE_TO", "GRASP", "PLACE", "WAIT", "REQUEST_HELP", "DONE"]},
        "target_id": {"type": ["string", "null"]},
        "position": {"anyOf": [{"type": "array", "items": {"type": "number"}}, {"type": "null"}]},
        "reason": {"type": "string"},
        "max_execution_ms": {"type": "integer"},
    },
    "required": ["type", "target_id", "position", "reason", "max_execution_ms"],
}


def reload_config():
    load_dotenv("backend/.env", override=True)


def redact_error(value):
    text = str(value)
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JEV_API_KEY", "HYPER3D_API_KEY"):
        secret = os.getenv(name, "")
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text[:500]


class FrontierPlanner:
    def __init__(self, policy_id="gpt-6.1-sol"):
        reload_config()
        self.provider = "anthropic" if policy_id == "claude-opus-5-5" else "openai"
        self.model = policy_id
        self.key = os.getenv("ANTHROPIC_API_KEY" if self.provider == "anthropic" else "OPENAI_API_KEY", "")
        if not self.key:
            raise ValueError(f"Missing {self.provider} key in backend/.env")
        self.manifest = PolicyManifest(policy_id=policy_id, version="symbolic_p1", adapter_type="symbolic_tool_agent",
            model=self.model, prompt_hash=hashlib.sha256(PROMPT.encode()).hexdigest(), deterministic=False,
            parameters={"reasoning_effort": "low", "max_output_tokens": 1600 if self.provider == "openai" else 3000,
                        "temperature": "provider_default", "transport": "responses" if self.provider == "openai" else "messages",
                        "timeout_seconds": float(os.getenv("POLICY_TIMEOUT_SECONDS", "40"))})
        self.calls = 0
        self.inference_record = None

    def reset(self, task, capabilities, version=None):
        self.task, self.capabilities = task, capabilities
        self.history = []

    async def predict(self, obs):
        input_data = {"capabilities": self.capabilities, "observation": obs.model_dump(mode="json"),
                      "recent_actions": self.history[-8:]}
        user = json.dumps(input_data)
        timeout = float(os.getenv("POLICY_TIMEOUT_SECONDS", "40"))
        self.calls += 1
        async with httpx.AsyncClient(timeout=timeout) as client:
            if self.provider == "openai":
                response = await client.post(os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/") + "/responses",
                    headers={"Authorization": f"Bearer {self.key}"}, json={
                        "model": self.model, "instructions": PROMPT, "input": user,
                        "reasoning": {"effort": "low"}, "max_output_tokens": 1600,
                        "text": {"format": {"type": "json_schema", "name": "robot_action", "strict": True, "schema": ACTION_SCHEMA}}})
            else:
                response = await client.post("https://api.anthropic.com/v1/messages",
                    headers={"x-api-key": self.key, "anthropic-version": "2023-06-01"}, json={
                        "model": self.model, "system": PROMPT, "max_tokens": 3000,
                        "messages": [{"role": "user", "content": user}],
                        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": ACTION_SCHEMA}}})
            # Never include a credential or request headers in persisted errors.
            if response.is_error:
                safe = response.text.replace(self.key, "[REDACTED]")
                raise RuntimeError(f"{self.provider} HTTP {response.status_code}: {redact_error(safe)[:350]}")
            raw = response.json()
        if self.provider == "openai":
            texts = [c["text"] for item in raw.get("output", []) for c in item.get("content", []) if c.get("type") == "output_text"]
        else:
            texts = [c["text"] for c in raw.get("content", []) if c.get("type") == "text"]
        if not texts:
            raise RuntimeError(f"{self.provider}: no action text; status={raw.get('status', raw.get('stop_reason'))}")
        action = PolicyAction.model_validate_json("".join(texts))
        self.inference_record = {"provider": self.provider, "requested_model": self.model,
            "response_model": raw.get("model"), "response_id": raw.get("id"),
            "usage": raw.get("usage"), "action_text": "".join(texts)}
        self.history.append({"step": obs.step, "action": action.model_dump()})
        return action


POLICY_IDS = ["scripted_open_loop", "scripted_reobserve", "scripted_obstacle_aware", "gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"]


def make_policy(policy_id):
    if policy_id == "scripted_obstacle_aware":
        return ObstacleAwarePolicy()
    if policy_id in ("scripted_open_loop", "scripted_reobserve"):
        return ScriptedPolicy(policy_id == "scripted_reobserve")
    if policy_id in POLICY_IDS:
        return FrontierPlanner(policy_id)
    raise ValueError(f"Unknown policy: {policy_id}")


def policy_catalog():
    reload_config()
    return [{"id": p, "available": p.startswith("scripted_") or bool(os.getenv("ANTHROPIC_API_KEY" if p.startswith("claude") else "OPENAI_API_KEY")),
             "kind": "scripted" if p.startswith("scripted_") else "frontier"} for p in POLICY_IDS]
