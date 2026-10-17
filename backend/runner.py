"""Fresh policy/environment executions with durable independent verification."""
import asyncio
import time
import uuid
import httpx
from .robosim import environment_for, RoboSimEnvironment
from .models import CaseResult
from .oracle import evaluate
from .policies import make_policy, redact_error
from .storage import canonical_hash


async def run_case(scenario, policy_id, storage, delay_seconds=0, on_event=None, on_env=None, checkpoint=None):
    episode_id = "ep_" + uuid.uuid4().hex[:16]
    policy = make_policy(policy_id)
    loop = asyncio.get_running_loop()
    def sink(event):
        storage.append_event(event)
        if on_event:
            loop.call_soon_threadsafe(on_event, event)
    env = environment_for(scenario, episode_id, sink)
    if isinstance(env, RoboSimEnvironment):
        env.realtime = bool(delay_seconds)
    try:
        started = time.perf_counter()
        obs = await asyncio.to_thread(env.reset, scenario, scenario.seed) if isinstance(env, RoboSimEnvironment) else env.reset(scenario, scenario.seed)
        env.controller_manifest = policy.manifest.model_dump(mode="json")
        env.model_calls, env.inference_elapsed_ms = policy.calls, 0.
        if on_env:
            on_env(env)
        policy.reset(scenario.task, env.capabilities(), policy.manifest.version)
        env.controller_manifest = policy.manifest.model_dump(mode="json")
        storage.save(f"episodes/{episode_id}/scenario.json", scenario.model_dump(mode="json"))
        env.emit("policy.manifest", policy.manifest.model_dump())
        inference_ms = 0.0
        while not env.terminated and not env.truncated:
            if checkpoint:
                halt = await checkpoint(env)
                if halt:
                    env.halt_reason, env.terminated = halt, True
                    env.emit("policy.error", {"error": halt})
                    break
            obs = env.observation()
            env.emit("policy.observation", obs.model_dump())
            inference_start = time.perf_counter()
            try:
                action = await asyncio.wait_for(policy.predict(obs), timeout=45)
            except (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException) as exc:
                env.halt_reason = "POLICY_TIMEOUT"
                env.truncated = True
                env.emit("policy.timeout", {"error": type(exc).__name__, "provider_response": policy.inference_record})
                break
            except Exception as exc:
                env.halt_reason = f"POLICY_ERROR:{type(exc).__name__}"
                env.terminated = True
                env.emit("policy.error", {"error": redact_error(exc), "provider_response": policy.inference_record})
                break
            finally:
                inference_ms += (time.perf_counter() - inference_start) * 1000
                env.model_calls, env.inference_elapsed_ms = policy.calls, inference_ms
            env.emit("policy.decision", {"action": action.model_dump(), "inference_wall_ms": (time.perf_counter() - inference_start) * 1000,
                                         "provider_response": policy.inference_record})
            if isinstance(env, RoboSimEnvironment):
                await asyncio.to_thread(env.step, action)
            else:
                env.step(action)
            if delay_seconds and not env.terminated and not env.truncated:
                await asyncio.sleep(delay_seconds)
        outcome, reason, success = evaluate(env)
        env.world.state = {"PASS": "PASSED", "FAIL": "FAILED", "UNKNOWN": "FAILED", "TIMEOUT": "TIMEOUT", "ESCALATED": "ESCALATED"}[outcome]
        env._publish()
        result = CaseResult(episode_id=episode_id, case_id=scenario.case_id, scenario_hash=canonical_hash(scenario),
            source=scenario.source, policy=policy.manifest, outcome=outcome, reason=reason, task_success=success,
            constraint_violations=env.violations, actions=env.world.step, recovery_attempts=env.recovery_attempts,
            sim_elapsed_ms=env.world.sim_elapsed_ms, wall_elapsed_ms=(time.perf_counter() - started) * 1000,
            inference_elapsed_ms=inference_ms, model_calls=policy.calls,
            trace_ref=f"episodes/{episode_id}/trace.jsonl")
        env.emit("benchmark.case_finished", result.model_dump())
        storage.save(f"episodes/{episode_id}/result.json", result.model_dump(mode="json"))
        storage.save(f"episodes/{episode_id}/final_world.json", env.world.model_dump(mode="json"))
        # Physical camera changes were not known at episode reset; retain actual transitions separately.
        storage.save(f"episodes/{episode_id}/captured_disturbances.json", [d.model_dump(mode="json") for d in env.live_disturbances])
        return result, env
    finally:
        if isinstance(env, RoboSimEnvironment):
            await asyncio.to_thread(env.close)
