"""Local FastAPI transport; webcam ingest and the policy runner share one state bus."""
from __future__ import annotations
import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import Field

from .capture import Tracker
from .generator import generate_cases, sanity_case
from .environments import environment_catalog
from .benchmark_dispatch import execution_backend_catalog
from .models import Calibration, CaseResult, Disturbance, GateConfig, Model, Scenario
from .oracle import compare_results
from .policies import policy_catalog
from .robots import robot_catalog, robot_config_for
from .warehouse import warehouse_cases
from . import jev, hyper3d
from .production import ProductionLine
from .runtime import Runtime
from .storage import Storage

load_dotenv("backend/.env")
runtime = Runtime(Storage(os.getenv("FAULTLINE_DATA_DIR", "data")))
production_lines = {}
app = FastAPI(title="FAULTLINE Pick", version="1.0", description="Real RGB estimates → simulated policies → independently verified regression results")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3300", "http://127.0.0.1:3300"],
                   allow_methods=["GET", "POST", "DELETE"], allow_headers=["*"])


@app.exception_handler(ValueError)
async def invalid(request, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=422, content={"error": str(exc)})


def auth(session_id, authorization):
    token = authorization.removeprefix("Bearer ") if authorization else ""
    try:
        return runtime.authenticate(session_id, token)
    except PermissionError as exc:
        raise HTTPException(401, str(exc))


def robosim_health():
    """Optional native runtime availability; the core executor stays independent."""
    try:
        from .robosim import status
    except ImportError:
        return {"available": False, "verified": False,
                "reason": "Optional RoboSim Studio runtime is not installed"}
    return status()


async def prepare_native_preview(session, case):
    loop = asyncio.get_running_loop()
    await asyncio.to_thread(runtime.preview, session, case,
        notify=lambda event: loop.call_soon_threadsafe(runtime.publish, session, event))


@app.get("/api/health")
def health():
    evidence = jev_evidence()
    jev_verified = all(evidence.get(kind, {}).get("status") == "response_validated" for kind in ("triage", "grounding"))
    return {"ok": True, "schema_version": "1.0", "execution": "local_cartesian_or_six_joint_kinematics", "policies": policy_catalog(),
            "robots": [{**r, "requires_metric": "workcell_normalized" not in r["coordinate_frames"]} for r in robot_catalog()],
            "robosim": robosim_health(),
            "environments": environment_catalog(robosim_health().get("available", False)),
            "hyper3d": hyper3d.status(),
            "execution_backends": execution_backend_catalog(runtime.storage),
            "jev": {"available": jev.available(), "verified": jev_verified, "model": jev.JEV_MODEL},
            "depth_available": False, "data_mode": "real_execution"}


@app.get("/api/environments")
def environments():
    return {"environments": environment_catalog(robosim_health().get("available", False)),
            "execution_backends": execution_backend_catalog(runtime.storage)}


@app.post("/api/camera/session")
def create_session():
    s = runtime.create_session()
    return {"session_id": s.id, "token": s.token, "expires_at_ms": s.expires_at * 1000,
            "capture_url": os.getenv("FAULTLINE_PUBLIC_URL", "http://localhost:3300") + "/lab",
            "ws_url": f"/ws/live/{s.id}", "source": "laptop_web_rgb"}


@app.get("/api/sessions/{session_id}")
def state(session_id: str, authorization: str | None = Header(None)):
    return runtime.state(auth(session_id, authorization))


async def ingest(s, data, seq, timestamp, source="laptop_web_rgb", capture_id=None):
    async with s.lock:
        if source not in ("laptop_web_rgb", "desk_view_window_rgb"):
            raise ValueError("Unsupported RGB source")
        capture_changed = bool(capture_id and capture_id != getattr(s, "capture_id", None))
        if capture_id and capture_id in getattr(s, "retired_capture_ids", []):
            raise ValueError("STALE_CAPTURE: this optical source has been replaced")
        if (source != s.tracker.camera_source or capture_changed) and s.job and not s.job.done():
            raise ValueError("Finish the current episode before changing camera source")
        if source != s.tracker.camera_source or capture_changed:
            if capture_changed:
                previous_id = getattr(s, "capture_id", None)
                retired = getattr(s, "retired_capture_ids", [])
                s.retired_capture_ids = (retired + ([previous_id] if previous_id else []))[-32:]
                s.capture_id = capture_id
            # A different optical source requires a new pixel-to-workspace calibration.
            runtime.camera_workcell(s)
            s.tracker = Tracker(s.id)
            s.tracker.camera_source = source
        ref = f"frames/{s.id}/{seq:08d}.jpg"
        scene = s.tracker.ingest(data, seq, timestamp, ref)
        s.tracker.camera_source = source
        scene.camera_source = source
        runtime.storage.path(ref).parent.mkdir(parents=True, exist_ok=True)
        runtime.storage.path(ref).write_bytes(data)
        event = {"kind": "camera.frame_meta", "seq": seq, "timestamp_ms": timestamp,
                 "data": {"frame_ref": ref, "source": source, "depth_available": False}}
        runtime.publish(s, event)
        runtime.publish(s, {"kind": "observed.scene", "data": scene.model_dump(mode="json")})
        if s.env and s.job and not s.job.done() and s.live_sync:
            s.env.emit("camera.frame_meta", event["data"] | {"seq": seq, "capture_timestamp_ms": timestamp})
            s.env.emit("observed.scene", scene.model_dump(mode="json"))
            s.env.sync_observation(scene)
        return scene


@app.post("/api/camera/{session_id}/frame")
async def post_frame(session_id: str, request: Request, seq: int, timestamp_ms: float,
                     source: Literal["laptop_web_rgb", "desk_view_window_rgb"] = "laptop_web_rgb",
                     capture_id: str | None = None, authorization: str | None = Header(None)):
    s = auth(session_id, authorization)
    if capture_id is not None and not __import__("re").fullmatch(r"[a-zA-Z0-9_-]{1,80}", capture_id):
        raise ValueError("Invalid optical capture ID")
    if int(request.headers.get("content-length", "0")) > 1_500_000:
        raise HTTPException(413, "Frame must be under 1.5 MB")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 1_500_000:
            raise HTTPException(413, "Frame must be under 1.5 MB")
    scene = await ingest(s, bytes(data), seq, timestamp_ms, source, capture_id)
    return {"accepted": True, "observed": scene.model_dump(mode="json")}


class CalibrateRequest(Model):
    session_id: str
    calibration: Calibration


@app.post("/api/workcell/calibration")
async def calibrate(body: CalibrateRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    if s.job and not s.job.done():
        raise ValueError("Finish the running episode before recalibrating")
    async with s.lock:
        s.tracker.calibrate(body.calibration)
    return {"calibrated": True, "coordinate_frame": s.tracker.coordinate_frame, "workspace": s.tracker.workspace}


class SeedRequest(Model):
    session_id: str
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]+$")
    label: str = Field(max_length=80)
    bbox: tuple[float, float, float, float]
    dimensions: tuple[float, float, float] | None = None


@app.post("/api/objects/seed")
async def seed(body: SeedRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    if s.job and not s.job.done():
        raise ValueError("Finish the running episode before reseeding objects")
    async with s.lock:
        obj = s.tracker.seed(body.id, body.label, body.bbox, body.dimensions)
    return {"object": obj.model_dump(mode="json")}


class RunRequest(Model):
    session_id: str
    policy_id: str = "scripted_open_loop"
    robot_id: str = "cartesian"
    target_id: str = "chocolate_A"
    case_id: str | None = None
    delay_seconds: float = Field(default=1.5, ge=0, le=5)


@app.post("/api/policy/run")
async def start(body: RunRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    case = Scenario.model_validate(runtime.storage.load(f"scenarios/{body.case_id}.json")) if body.case_id else runtime.live_scenario(s, body.target_id, body.robot_id)
    return runtime.start(s, case, body.policy_id, body.delay_seconds, live_sync=body.case_id is None)


@app.post("/api/replays/{case_id}/rerun")
async def rerun(case_id: str, body: RunRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    case = Scenario.model_validate(runtime.storage.load(f"scenarios/{case_id}.json"))
    return runtime.start(s, case, body.policy_id, body.delay_seconds)


class CaptureRequest(Model):
    session_id: str
    name: str = Field(default="Captured warehouse regression", max_length=120)
    confirmed: bool = False


class SessionRequest(Model):
    session_id: str


class WarehouseRequest(SessionRequest):
    count: int = Field(default=4, ge=1, le=20)
    seed: int = 42017
    robot_id: str = "industrial_6r"


@app.post("/api/workcells/warehouse")
async def warehouse(body: WarehouseRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    if s.job and not s.job.done():
        raise ValueError("Finish the current episode before changing the workcell")
    cases = warehouse_cases(body.count, body.seed)
    for case in cases:
        config = robot_config_for(body.robot_id, case.initial_scene.workspace, case.initial_scene.coordinate_frame)
        # A different robot is a different immutable experiment, with a distinct ID.
        if body.robot_id != "industrial_6r":
            case.case_id += "-" + body.robot_id
            case.name += " · " + body.robot_id
            if config:
                case.provenance["robot_config"] = config
            else:
                case.provenance.pop("robot_config", None)
            case.provenance["robot_profile"] = body.robot_id
        runtime.storage.save_scenario(case)
    runtime.preview(s, cases[0])
    return {"scenarios": [c.model_dump(mode="json") for c in cases], "preview_case_id": cases[0].case_id, "executed": False}


class RoboSimRequest(SessionRequest):
    count: int = Field(default=2, ge=1, le=4)
    seed: int = Field(default=42017, ge=0, le=2_147_483_647)


@app.post("/api/workcells/robosim")
async def robosim_workcell(body: RoboSimRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    if s.job and not s.job.done():
        raise ValueError("Finish the current episode before changing the workcell")
    availability = robosim_health()
    if not availability.get("available"):
        raise HTTPException(503, availability.get("reason", "RoboSim Studio runtime is unavailable"))
    from .robosim import make_robosim_cases
    cases = make_robosim_cases(body.count, body.seed)
    async with s.lock:
        for case in cases:
            runtime.storage.save_scenario(case)
        # First native imports and physics compilation may take several seconds.
        # Keep the API and original executor responsive while preparing the view.
        await prepare_native_preview(s, cases[0])
    return {"scenarios": [c.model_dump(mode="json") for c in cases],
            "preview_case_id": cases[0].case_id, "executed": False,
            "execution_backend": "robosimstudio_cpu"}


@app.post("/api/workcells/camera")
async def camera_workcell(body: SessionRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    runtime.camera_workcell(s)
    return {"mode": "camera", "calibrated": s.tracker.calibration is not None}


class PreviewRequest(SessionRequest):
    case_id: str = Field(pattern=r"^[a-zA-Z0-9_-]+$")


@app.post("/api/workcells/scenario")
async def preview_scenario(body: PreviewRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    try:
        case = Scenario.model_validate(runtime.storage.load(f"scenarios/{body.case_id}.json"))
    except FileNotFoundError:
        raise HTTPException(404, "Saved scenario does not exist")
    if case.provenance.get("execution_backend") == "robosimstudio_cpu":
        availability = robosim_health()
        if not availability.get("available"):
            raise HTTPException(503, availability.get("reason", "RoboSim Studio runtime is unavailable"))
        async with s.lock:
            await prepare_native_preview(s, case)
    else:
        runtime.preview(s, case)
    return {"scenario": case.model_dump(mode="json"), "executed": False}


@app.get("/api/jev/evidence")
def jev_evidence():
    try:
        return runtime.storage.load("jev-verification.json")
    except FileNotFoundError:
        return {"status": "unverified", "network_payload_sent": False}


class DiagnoseRequest(SessionRequest):
    episode_id: str = Field(pattern=r"^ep_[a-zA-Z0-9_-]+$")


@app.post("/api/jev/triage")
async def jev_triage(body: DiagnoseRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    episode = get_episode(body.episode_id)
    try:
        result = await jev.triage_episode(episode["scenario"], episode["result"], episode["events"])
    except jev.JevError as exc:
        raise HTTPException(502, str(exc))
    identity = "jev_" + uuid.uuid4().hex[:12]
    runtime.storage.save(f"diagnostics/{identity}.json", result)
    runtime.publish(s, {"kind": "diagnostic.completed", "data": {"id": identity, "episode_id": body.episode_id,
                     "provider": "typesafe", "model": result["response_model"], "advisory_only": True}})
    return {"evidence_ref": f"diagnostics/{identity}.json", **result}


@app.post("/api/scenes/snapshot")
async def snapshot(body: SessionRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    scene = s.tracker.scene()
    if not scene.objects:
        raise ValueError("Select objects before taking a scene snapshot")
    ref = f"snapshots/{s.id}-{scene.seq}.json"
    runtime.storage.save(ref, scene.model_dump(mode="json"))
    return {"snapshot_ref": ref, "scene": scene.model_dump(mode="json")}


class ControlRequest(SessionRequest):
    command: Literal["pause", "resume", "stop"]


@app.post("/api/policy/control")
async def control(body: ControlRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    if not s.job or s.job.done():
        raise ValueError("No active episode to control")
    if body.command == "stop":
        s.stop_requested = True
        s.paused = False
    else:
        s.paused = body.command == "pause"
    return {"paused": s.paused, "stop_requested": s.stop_requested}


@app.post("/api/scenarios/from-live")
async def from_live(body: CaptureRequest, authorization: str | None = Header(None)):
    return runtime.from_live(auth(body.session_id, authorization), body.name, body.confirmed)


@app.get("/api/scenarios")
def scenarios():
    return {"scenarios": runtime.storage.scenarios()}


@app.get("/api/scenarios/{case_id}")
def scenario(case_id: str):
    try:
        return runtime.storage.load(f"scenarios/{case_id}.json")
    except FileNotFoundError:
        raise HTTPException(404, "Scenario does not exist")


class InjectRequest(Model):
    session_id: str
    disturbance: Disturbance


@app.post("/api/disturbances/inject")
async def inject(body: InjectRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    if not s.env or not s.job or s.job.done():
        raise ValueError("Start an episode before injecting a disturbance")
    if s.mode == "scenario_rerun":
        raise ValueError("Saved-scenario reruns are isolated; start a live trial to inject a new disturbance")
    d = body.disturbance.model_copy(update={"source": "operator_injected", "after_action_index": s.env.world.step})
    # A deliberately injected virtual move must not be reclassified as a physical
    # disturbance when the unchanged camera estimate arrives a frame later.
    s.live_sync = False
    s.mode = "operator_injected"
    s.env.apply_disturbance(d)
    s.env.live_disturbances.append(d)
    s.env._publish()
    return {"injected": True, "disturbance": d.model_dump(mode="json")}


class BenchRequest(Model):
    session_id: str
    case_ids: list[str] = Field(default_factory=list, max_length=100)
    generated_count: int = Field(default=0, ge=0, le=100)
    warehouse_count: int = Field(default=0, ge=0, le=20)
    baseline: str = "scripted_open_loop"
    candidate: str = "scripted_reobserve"
    gate: GateConfig = Field(default_factory=GateConfig)
    execution_backend: Literal["local", "modal_cpu"] = "local"
    concurrency: int = Field(default=2, ge=1, le=4)


@app.post("/api/benchmarks/run")
async def benchmark(body: BenchRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    cases = [Scenario.model_validate(runtime.storage.load(f"scenarios/{case_id}.json")) for case_id in body.case_ids]
    cases += generate_cases(body.generated_count)
    if body.warehouse_count:
        cases += warehouse_cases(body.warehouse_count)
    if len(cases) > 100 or len({c.case_id for c in cases}) != len(cases):
        raise ValueError("Choose up to 100 distinct cases")
    return runtime.benchmark(s, cases, body.baseline, body.candidate, body.gate,
                             execution_backend=body.execution_backend, concurrency=body.concurrency)


@app.get("/api/benchmarks")
def list_benchmarks():
    saved = {p.stem: json.loads(p.read_text()) for p in runtime.storage.path("benchmarks").glob("*.json")}
    saved.update(runtime.benchmarks)
    return {"benchmarks": sorted(saved.values(), key=lambda b: b.get("created_at_ms", 0), reverse=True)}


@app.get("/api/benchmarks/{run_id}")
def get_benchmark(run_id: str):
    if run_id in runtime.benchmarks:
        return runtime.benchmarks[run_id]
    try:
        return runtime.storage.load(f"benchmarks/{run_id}.json")
    except FileNotFoundError:
        raise HTTPException(404, "Benchmark does not exist")


@app.get("/api/benchmarks/{run_id}/cases/{case_id}")
def benchmark_case(run_id: str, case_id: str):
    bench = get_benchmark(run_id)
    results = [r for r in bench["results"] if r["case_id"] == case_id]
    if not results:
        if not any(c["case_id"] == case_id for c in bench["cases"]):
            raise HTTPException(404, "Case is not part of this benchmark")
    return {"case_id": case_id, "results": results, "status": "COMPLETED" if len(results) == 2 else "PENDING"}


class GateRequest(SessionRequest):
    baseline_episode_ids: list[str] = Field(min_length=1, max_length=100)
    candidate_episode_ids: list[str] = Field(min_length=1, max_length=100)
    config: GateConfig = Field(default_factory=GateConfig)


@app.post("/api/gates/evaluate")
def gate(body: GateRequest, authorization: str | None = Header(None)):
    s = auth(body.session_id, authorization)
    a = [CaseResult.model_validate(runtime.storage.load(f"episodes/{ep}/result.json")) for ep in body.baseline_episode_ids]
    b = [CaseResult.model_validate(runtime.storage.load(f"episodes/{ep}/result.json")) for ep in body.candidate_episode_ids]
    result = compare_results(a, b, body.config)
    runtime.publish(s, {"kind": "gate.updated", "data": result})
    return result


@app.get("/api/episodes/{episode_id}")
def get_episode(episode_id: str):
    try:
        events = [json.loads(line) for line in runtime.storage.path(f"episodes/{episode_id}/trace.jsonl").read_text().splitlines()]
        return {"result": runtime.storage.load(f"episodes/{episode_id}/result.json"),
                "scenario": runtime.storage.load(f"episodes/{episode_id}/scenario.json"), "events": events}
    except FileNotFoundError:
        raise HTTPException(404, "Completed episode does not exist")


@app.get("/api/evidence/{folder}/{identity}/{filename}")
def evidence(folder: Literal["episodes", "frames"], identity: str, filename: str,
             session_id: str, authorization: str | None = Header(None)):
    s = auth(session_id, authorization)
    if folder == "frames" and identity != s.id:
        raise HTTPException(403, "Frame belongs to a different camera session")
    path = runtime.storage.path(f"{folder}/{identity}/{filename}")
    if not path.is_file():
        raise HTTPException(404, "Evidence does not exist")
    return FileResponse(path, filename=filename)


@app.websocket("/ws/live/{session_id}")
async def live_ws(ws: WebSocket, session_id: str):
    await ws.accept()
    # Token in first message keeps it out of URL/access logs.
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=5)
        s = runtime.authenticate(session_id, hello.get("token", ""))
    except Exception:
        await ws.close(4401)
        return
    queue = asyncio.Queue(maxsize=64)
    s.subscribers.add(queue)
    try:
        await ws.send_json({"kind": "session.state", "data": runtime.state(s)})
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=2)
            except asyncio.TimeoutError:
                event = {"kind": "session.state", "data": runtime.state(s)}
            await ws.send_json(event)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        s.subscribers.discard(queue)


@app.websocket("/ws/camera/{session_id}")
async def camera_ws(ws: WebSocket, session_id: str):
    await ws.accept()
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=5)
        s = runtime.authenticate(session_id, hello.get("token", ""))
        while True:
            meta = await ws.receive_json()
            data = await ws.receive_bytes()
            scene = await ingest(s, data, int(meta["seq"]), float(meta["timestamp_ms"]), meta.get("source", "laptop_web_rgb"))
            await ws.send_json({"kind": "observed.scene", "data": scene.model_dump(mode="json")})
    except PermissionError:
        await ws.close(4401)
    except (ValueError, KeyError):
        await ws.close(4400)
    except WebSocketDisconnect:
        pass


class ReconstructionRequest(SessionRequest):
    physical_footprint_m: tuple[float, float] | None = None
    object_id: str = Field(pattern=r"^[a-zA-Z0-9_-]+$")


@app.post("/api/assets/reconstruct")
async def reconstruct_asset(body: ReconstructionRequest, authorization: str | None = Header(None)):
    session = auth(body.session_id, authorization)
    async with session.lock:
        job = hyper3d.begin_job(runtime.storage, session, body.object_id, physical_footprint_m=body.physical_footprint_m)
        if job["status"] == "QUEUED":
            task = asyncio.create_task(hyper3d.execute_job(runtime.storage, job["job_id"]))
            runtime.tasks.add(task)
            task.add_done_callback(runtime.tasks.discard)
    return job


@app.get("/api/assets")
def object_assets(session_id: str, authorization: str | None = Header(None)):
    auth(session_id, authorization)
    return {"assets": hyper3d.get_assets(runtime.storage, session_id)}


@app.get("/api/assets/jobs/{job_id}")
def asset_job(job_id: str, authorization: str | None = Header(None)):
    try:
        job = hyper3d.get_job(runtime.storage, job_id)
    except FileNotFoundError:
        raise HTTPException(404, "Object reconstruction does not exist")
    auth(job["camera_session"], authorization)
    return job


@app.get("/api/assets/{job_id}/model.glb")
def reconstructed_model(job_id: str):
    # Same local evidence-read scope as persisted episode/scenario endpoints.
    try:
        job = hyper3d.get_job(runtime.storage, job_id)
    except FileNotFoundError:
        raise HTTPException(404, "Object reconstruction does not exist")
    if job["status"] != "SUCCEEDED":
        raise HTTPException(409, "Reconstruction is not complete")
    return FileResponse(runtime.storage.path(f"reconstructions/{job_id}/model.glb"), media_type="model/gltf-binary", filename=f"{job_id}.glb")


class ProductionRequest(SessionRequest):
    execution_backend: Literal["robosimstudio_cpu", "kinematic"] = "robosimstudio_cpu"
    policy_id: str = "jev_gpt-6.1-sol"
    delay_seconds: float = Field(default=.7, ge=0, le=3)


class ProductionChangeRequest(SessionRequest):
    change: Literal["move_component", "reroute_next"]


@app.post("/api/production/start")
async def start_production(body: ProductionRequest, authorization: str | None = Header(None)):
    session = auth(body.session_id, authorization)
    if body.execution_backend == "robosimstudio_cpu" and not robosim_health().get("available"):
        raise HTTPException(503, "Native contact physics is unavailable; choose the kinematic execution option")
    if session.job and not session.job.done():
        raise ValueError("Finish the current execution before starting a production batch")
    if session.env and hasattr(session.env, "close"):
        session.env.close()
    session.env, session.latest_result, session.error = None, None, None
    session.status, session.mode = "RUNNING", "production_workflow"
    session.live_sync, session.paused, session.stop_requested = False, False, False
    def bind(env):
        session.env = env
    async def checkpoint(env):
        while session.paused and not session.stop_requested:
            await asyncio.sleep(.1)
        return "POLICY_ERROR:OPERATOR_STOPPED" if session.stop_requested else None
    line = ProductionLine(runtime.storage, publish=lambda event: runtime.publish(session, event),
                          on_env=bind, checkpoint=checkpoint)
    job = line.create(session.id, body.policy_id, body.delay_seconds, execution_backend=body.execution_backend)
    production_lines[job["job_id"]] = line
    async def execute():
        try:
            final = await line.run(job["job_id"])
            session.status = final["status"]
            session.error = final.get("error")
            completed = [stage["result"] for stage in final["stages"] if stage.get("result")]
            if completed:
                session.latest_result = CaseResult.model_validate(completed[-1])
        except Exception as exc:
            session.status, session.error = "ERROR", str(exc)[:500]
    session.job = asyncio.create_task(execute())
    return job


def load_production(job_id):
    line = production_lines.get(job_id)
    if line:
        return line, line.get(job_id)
    if not __import__("re").fullmatch(r"production_[a-f0-9]{12}", job_id):
        raise ValueError("Invalid production job ID")
    try:
        return None, runtime.storage.load(f"production/{job_id}.json")
    except FileNotFoundError:
        raise HTTPException(404, "Production batch does not exist")


@app.get("/api/production/{job_id}")
def production_job(job_id: str, authorization: str | None = Header(None)):
    line, job = load_production(job_id)
    session = auth(job["session_id"], authorization)
    episode_ids = {stage.get("episode_id") for stage in job["stages"] if stage.get("episode_id")}
    if session.env and session.env.scenario.provenance.get("workflow_id") == job_id:
        episode_ids.add(session.env.episode_id)
    return {**job, "events": [event for event in session.events if event.get("episode_id") in episode_ids or
            (event["kind"].startswith("production.") and event["data"].get("job_id") == job_id)]}


@app.post("/api/production/{job_id}/change")
def change_production(job_id: str, body: ProductionChangeRequest, authorization: str | None = Header(None)):
    line, job = load_production(job_id)
    auth(body.session_id, authorization)
    if job["session_id"] != body.session_id:
        raise HTTPException(403, "Production batch belongs to a different session")
    if not line:
        raise ValueError("This saved batch is complete; start a fresh batch to introduce a change")
    return line.change(job_id, body.change)


@app.get("/api/production")
def list_production():
    """Saved local evidence has the same read scope as episode/benchmark evidence."""
    records = [__import__('json').loads(path.read_text()) for path in runtime.storage.path('production').glob('production_*.json')]
    return {"jobs": sorted(records, key=lambda job: job.get('created_at_ms', 0), reverse=True)}


@app.get("/api/production/{job_id}/evidence")
def production_evidence(job_id: str):
    _, job = load_production(job_id)
    events, last_result, last_case, world = [], None, None, None
    for stage in job['stages']:
        result = stage.get('result')
        if not result:
            continue
        episode = get_episode(result['episode_id'])
        events.extend(episode['events'])
        last_result, last_case = result, episode['scenario']
        world = runtime.storage.load(f"episodes/{result['episode_id']}/final_world.json")
    return {**job, "events": events, "world": world, "result": last_result,
            "task": last_case['task'] if last_case else None,
            "controller": {"manifest": last_result['policy'], "model_calls": last_result['model_calls'],
                           "inference_elapsed_ms": last_result['inference_elapsed_ms']} if last_result else None,
            "evidence_mode": "saved_execution"}
