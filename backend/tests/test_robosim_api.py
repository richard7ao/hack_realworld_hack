"""Optional physics must fail explicitly without replacing a working workcell."""
import importlib

from fastapi.testclient import TestClient

from backend.generator import sanity_case
from backend.runtime import Runtime
from backend.storage import Storage, canonical_hash


def test_missing_native_runtime_preserves_working_preview(tmp_path, monkeypatch):
    module = importlib.import_module("backend.app")
    runtime = Runtime(Storage(tmp_path))
    monkeypatch.setattr(module, "runtime", runtime)
    monkeypatch.setattr(module, "robosim_health", lambda: {
        "available": False, "verified": False, "reason": "Optional test runtime is absent"})
    with TestClient(module.app) as client:
        session = client.post("/api/camera/session").json()
        headers = {"Authorization": "Bearer " + session["token"]}
        identity = {"session_id": session["session_id"]}
        loaded = client.post("/api/workcells/warehouse", headers=headers, json=identity | {"count": 1})
        assert loaded.status_code == 200
        before = runtime.sessions[session["session_id"]].env
        assert client.post("/api/workcells/robosim", json=identity).status_code == 401
        unavailable = client.post("/api/workcells/robosim", headers=headers, json=identity)
        assert unavailable.status_code == 503 and "absent" in unavailable.json()["detail"]
        assert runtime.sessions[session["session_id"]].env is before
        assert client.get("/api/health").json()["ok"] is True
        assert not list(tmp_path.glob("episodes/*/result.json"))


def test_native_saved_case_cannot_silently_use_old_executor(tmp_path, monkeypatch):
    module = importlib.import_module("backend.app")
    runtime = Runtime(Storage(tmp_path))
    monkeypatch.setattr(module, "runtime", runtime)
    monkeypatch.setattr(module, "robosim_health", lambda: {
        "available": False, "verified": False, "reason": "Native engine unavailable"})
    case = sanity_case()
    case.case_id = "TEST-native-required"
    case.provenance["execution_backend"] = "robosimstudio_cpu"
    original_hash = runtime.storage.save_scenario(case)
    with TestClient(module.app) as client:
        session = client.post("/api/camera/session").json()
        headers = {"Authorization": "Bearer " + session["token"]}
        response = client.post("/api/workcells/scenario", headers=headers,
            json={"session_id": session["session_id"], "case_id": case.case_id})
        assert response.status_code == 503
        assert runtime.sessions[session["session_id"]].env is None
        assert canonical_hash(runtime.storage.load(f"scenarios/{case.case_id}.json")) == original_hash
        assert not list(tmp_path.glob("episodes/*/trace.jsonl"))
