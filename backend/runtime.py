"""One local state bus for camera estimates, execution and evidence."""
from __future__ import annotations
import asyncio
import json
import secrets
import time
import uuid
from dataclasses import dataclass, field

from .capture import Tracker
from .engine import collider_dimensions
from .robosim import environment_for
from .generator import generate_cases
from .models import CaseResult, Disturbance, GateConfig, Scenario, Task, Zone
from .oracle import compare_results
from .policies import make_policy
from .robots import robot_config_for
from .runner import run_case
from .storage import Storage, canonical_hash


@dataclass
class Session:
    id: str
    token: str
    tracker: Tracker
    expires_at: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    subscribers: set = field(default_factory=set)
    env: object = None
    latest_result: CaseResult | None = None
    job: asyncio.Task | None = None
    events: list = field(default_factory=list)
    status: str = "IDLE"
    error: str | None = None
    paused: bool = False
    live_sync: bool = False
    bus_seq: int = 0
    stop_requested: bool = False
    mode: str = "idle"


class Runtime:
    def __init__(self, storage=None):
        self.storage = storage or Storage()
        self.sessions: dict[str, Session] = {}
        self.benchmarks = {}
        self.tasks = set()

    def create_session(self):
        sid = "cam_" + uuid.uuid4().hex[:12]
        s = Session(sid, secrets.token_urlsafe(32), Tracker(sid), time.time() + 8 * 3600)
        self.sessions[sid] = s
        return s

    def authenticate(self, session_id, token):
        s = self.sessions.get(session_id)
        if not s or not token or not secrets.compare_digest(s.token, token) or time.time() > s.expires_at:
            raise PermissionError("Invalid or expired camera session")
        return s

    def publish(self, session, event):
        payload = event.model_dump(mode="json") if hasattr(event, "model_dump") else event
        session.bus_seq += 1
        payload = {"schema_version": "1.0", "timestamp_ms": time.time() * 1000,
                   "session_id": session.id, "episode_id": None, "seq": session.bus_seq,
                   **payload, "bus_seq": session.bus_seq}
        if payload["kind"] not in ("camera.frame_meta", "observed.scene", "sim.state"):
            session.events.append(payload)
            session.events = session.events[-500:]
        for q in list(session.subscribers):
            if q.full():
                q.get_nowait()
            q.put_nowait(payload)

    def state(self, s):
        tracker = s.tracker
        return {"session_id": s.id, "status": s.status, "error": s.error,
            "camera_status": "CONNECTED" if time.time() - tracker.received_at < 3 else "CAMERA_DISCONNECTED",
            "last_frame_age_ms": (time.time() - tracker.received_at) * 1000 if tracker.received_at else None,
            "calibrated": tracker.calibration is not None, "observed": tracker.scene().model_dump(mode="json"),
            "world": s.env.world.model_dump(mode="json") if s.env else None,
            "controller": {"manifest": getattr(s.env, "controller_manifest", None),
                "model_calls": getattr(s.env, "model_calls", 0),
                "inference_elapsed_ms": getattr(s.env, "inference_elapsed_ms", 0.)} if s.env else None,
            "episode_id": s.env.episode_id if s.env else None,
            "case_id": s.env.scenario.case_id if s.env else None,
            "task": s.env.scenario.task.model_dump(mode="json") if s.env else None,
            "scenario_source": s.env.scenario.source if s.env else None,
            "run_mode": s.mode,
            "paused": s.paused,
            "live_disturbances": [d.model_dump(mode="json") for d in s.env.live_disturbances] if s.env else [],
            "result": s.latest_result.model_dump(mode="json") if s.latest_result else None,
            "events": s.events[-100:], "running": bool(s.job and not s.job.done())}

    def preview(self, s, case, notify=None):
        if s.job and not s.job.done():
            raise ValueError("Finish the current episode before changing the workcell")
        if s.env and hasattr(s.env, "close"):
            s.env.close()
        env = environment_for(case, "preview_" + uuid.uuid4().hex[:12])
        try:
            env.reset(case, case.seed)
        except BaseException:
            if hasattr(env, "close"):
                env.close()
            raise
        env.world.state = "IDLE"
        s.env, s.latest_result, s.status = env, None, "PREVIEW"
        s.error, s.paused, s.live_sync, s.mode = None, False, False, "scenario_preview"
        event = {"kind": "workcell.previewed", "data": {"case_id": case.case_id, "executed": False}}
        notify(event) if notify else self.publish(s, event)

    def camera_workcell(self, s):
        if s.job and not s.job.done():
            raise ValueError("Finish the current episode before changing the workcell")
        if s.env and hasattr(s.env, "close"):
            s.env.close()
        s.env, s.latest_result, s.error = None, None, None
        s.status, s.mode, s.live_sync, s.paused = "IDLE", "idle", False, False

    def live_scenario(self, s, target_id, robot_id="cartesian"):
        if not s.tracker.calibration:
            raise ValueError("Set the workspace before starting")
        if time.time() - s.tracker.received_at > 3:
            raise ValueError("CAMERA_DISCONNECTED: reconnect before starting a live trial")
        scene = s.tracker.scene()
        target = next((o for o in scene.objects if o.id == target_id), None)
        if not target or not target.visible or target.confidence < 0.6:
            raise ValueError("TRACKING_UNCERTAIN: reselect a visible target")
        width, depth = scene.workspace
        extent = collider_dimensions(target)
        if extent[0] > width * .9 or extent[1] > depth * .9:
            raise ValueError("Selected target is too large for this workcell; widen the calibrated workspace or correct its declared geometry")
        bin_width = max(width * .32, extent[0] + width * .04)
        bin_depth = max(depth * .32, extent[1] + depth * .04)
        case = Scenario(case_id="LIVE-" + uuid.uuid4().hex[:10], name=f"Live capture: {target.label}",
            source="captured_live_rgb", seed=42017, task=Task(target_id=target_id), initial_scene=scene,
            destination=Zone(center=(width - bin_width / 2 - width * .03, depth - bin_depth / 2 - depth * .03, .04),
                             size=(bin_width, bin_depth, .2)),
            provenance={"camera_session": s.id, "capture_frame_ref": scene.frame_ref,
                        "camera_source": scene.camera_source,
                        "coordinate_note": "RGB planar estimate; dimensions/height are operator assumptions"})
        config = robot_config_for(robot_id, scene.workspace, scene.coordinate_frame)
        if config:
            case.provenance["robot_config"] = config
            case.provenance["robot_profile"] = robot_id
        return case

    def start(self, s, case, policy_id, delay_seconds=1.2, live_sync=False):
        if s.job and not s.job.done():
            raise ValueError("An episode is already running in this session")
        make_policy(policy_id)  # Validate availability before scheduling.
        if s.env and hasattr(s.env, "close"):
            s.env.close()
        s.latest_result, s.error, s.status = None, None, "RUNNING"
        s.live_sync, s.paused, s.stop_requested = live_sync, False, False
        s.mode = "live_capture" if live_sync else "scenario_rerun"
        def bind(env):
            s.env = env
        async def checkpoint(env):
            while s.paused and not s.stop_requested:
                await asyncio.sleep(.1)
            if s.stop_requested:
                return "POLICY_ERROR:OPERATOR_STOPPED"
            if s.live_sync and time.time() - s.tracker.received_at > 3:
                return "POLICY_ERROR:CAMERA_DISCONNECTED"
            return None
        async def execute():
            try:
                result, env = await run_case(case, policy_id, self.storage, delay_seconds,
                    on_event=lambda event: self.publish(s, event), on_env=bind, checkpoint=checkpoint)
                s.latest_result, s.env, s.status = result, env, result.outcome
            except Exception as exc:
                s.error, s.status = str(exc)[:500], "ERROR"
        s.job = asyncio.create_task(execute())
        return {"started": True, "case_id": case.case_id}

    def from_live(self, s, name, confirmed=False):
        if not confirmed:
            raise ValueError("Review measured disturbances and confirm the scenario before saving")
        if not s.env or not s.latest_result or (s.job and not s.job.done()):
            raise ValueError("Finish a live episode before compiling its regression case")
        original = s.env.scenario
        if original.source != "captured_live_rgb":
            raise ValueError("This episode was not a live camera capture")
        ds = s.env.live_disturbances
        if not ds:
            raise ValueError("No accepted live disturbance was recorded; move the target or explicitly inject a disturbance during the episode")
        case = original.model_copy(deep=True)
        case.case_id = "CAPTURE-" + uuid.uuid4().hex[:10]
        case.name = name or "Captured warehouse regression"
        case.disturbances = [d.model_copy(deep=True) for d in ds]
        physical = any(d.source == "camera_observed" for d in ds)
        case.source = "captured_live_rgb" if physical else "operator_defined"
        case.provenance.update({"capture_episode_id": s.env.episode_id, "capture_result": s.latest_result.model_dump(mode="json"),
            "operator_confirmed": True, "disturbance_count": len(ds),
            "note": "Fresh comparisons rerun both policies on this compiled manifest; original live trace is separate evidence"})
        scenario_hash = self.storage.save_scenario(case)
        self.publish(s, {"kind": "scenario.created", "data": {"case_id": case.case_id, "scenario_hash": scenario_hash}})
        return {"scenario": case.model_dump(mode="json"), "scenario_hash": scenario_hash}

    def benchmark(self, s, cases, baseline, candidate, config=None, *, execution_backend="local", concurrency=2):
        from .benchmark_dispatch import dispatch_cases, status as modal_status, validate_dispatch
        if execution_backend not in ("local", "modal_cpu") or not 1 <= concurrency <= 4:
            raise ValueError("Choose Local or Modal CPU and 1 to 4 simultaneous executions")
        if baseline == candidate:
            raise ValueError("Choose two different policies for a paired comparison")
        for policy_id in (baseline, candidate):
            make_policy(policy_id)
        if not cases or len({c.case_id for c in cases}) != len(cases):
            raise ValueError("Select distinct scenarios for the comparison")
        if execution_backend == "modal_cpu":
            availability = modal_status(self.storage)
            if not availability["available"]:
                raise ValueError(availability.get("reason") or "Modal workers are unavailable")
            if any(p not in availability["supported_policies"] for p in (baseline, candidate)):
                raise ValueError("The deployed Modal image supports scripted policies; frontier and Jev calls run locally")
            if any(c.source != "procedural" or c.initial_scene.frame_ref or c.initial_scene.sensor_mode != "PROCEDURAL" or c.provenance.get("execution_backend") == "robosimstudio_cpu" for c in cases):
                raise ValueError("Modal accepts generated kinematic cases only; captured scenes and native physics stay local")
        if execution_backend == "local" and any(c.provenance.get("execution_backend") == "robosimstudio_cpu" for c in cases):
            concurrency = min(concurrency, 2)  # Bound native solver memory on the local workstation.
        validate_dispatch(cases, baseline, candidate, execution_backend, concurrency)
        for case in cases:
            self.storage.save_scenario(case)
        run_id = "bench_" + uuid.uuid4().hex[:12]
        jobs = [{"case_id": c.case_id, "scenario_hash": canonical_hash(c), "policy_id": policy,
                 "role": role, "backend": execution_backend, "status": "QUEUED"}
                for c in cases for role, policy in (("baseline", baseline), ("candidate", candidate))]
        bench = {"id": run_id, "status": "RUNNING", "created_at_ms": time.time() * 1000,
            "baseline_policy": baseline, "candidate_policy": candidate, "total_executions": len(jobs),
            "execution_backend": execution_backend, "concurrency": concurrency,
            "active_executions": 0, "peak_concurrency": 0, "jobs": jobs, "executions": [],
            "completed_executions": 0, "results": [], "errors": [], "gate": None,
            "cases": [{"case_id": c.case_id, "source": c.source, "scenario_hash": canonical_hash(c)} for c in cases]}
        self.benchmarks[run_id] = bench
        self.storage.save(f"benchmarks/{run_id}.json", bench)
        def progress(event):
            job = next(j for j in jobs if j["case_id"] == event["case_id"] and j["role"] == event["role"])
            kind = event["type"]
            job.update({k: v for k, v in event.items() if k not in ("type", "result", "active_executions")})
            job["status"] = {"queued": "QUEUED", "started": "RUNNING", "completed": "DONE", "failed": "ERROR"}[kind]
            if kind == "completed":
                bench["results"].append(event["result"])
                bench["completed_executions"] += 1
                job["outcome"] = event["result"]["outcome"]
            bench["active_executions"] = sum(j["status"] == "RUNNING" for j in jobs)
            bench["peak_concurrency"] = max(bench["peak_concurrency"], bench["active_executions"])
            self.storage.save(f"benchmarks/{run_id}.json", bench)
            self.publish(s, {"kind": "benchmark.case_" + kind, "data": {"benchmark_id": run_id, **event}})
        async def execute():
            try:
                dispatched = await dispatch_cases(cases, baseline, candidate, self.storage,
                    backend=execution_backend, concurrency=concurrency, on_progress=progress)
                bench["executions"] = dispatched["executions"]
                bench["actual_worker_overlap"] = dispatched["actual_worker_overlap"]
                bench["errors"] = dispatched["errors"]
                bench["peak_concurrency"] = dispatched["peak_concurrency"]
                bench["gate"] = compare_results(dispatched["baseline"], dispatched["candidate"], config or GateConfig())
                bench["status"] = "ERROR" if bench["errors"] else "DONE"
                self.publish(s, {"kind": "gate.updated", "data": bench["gate"]})
            except Exception as exc:
                bench["status"] = "ERROR"
                bench["errors"].append(str(exc)[:500])
            finally:
                bench["active_executions"] = 0
                self.storage.save(f"benchmarks/{run_id}.json", bench)
        task = asyncio.create_task(execute())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return bench
