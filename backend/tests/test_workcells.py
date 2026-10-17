"""Workcell previews are definitions, never completed execution evidence."""
import importlib
import asyncio

from fastapi.testclient import TestClient

from backend.runtime import Runtime
from backend.storage import Storage, canonical_hash
from backend.warehouse import warehouse_cases
from backend.runner import run_case


def test_warehouse_preview_then_fresh_execution_and_camera_restore(tmp_path, monkeypatch):
    module = importlib.import_module("backend.app")
    runtime = Runtime(Storage(tmp_path))
    monkeypatch.setattr(module, "runtime", runtime)
    with TestClient(module.app) as client:
        session = client.post("/api/camera/session").json()
        sid = session["session_id"]
        headers = {"Authorization": "Bearer " + session["token"]}
        payload = {"session_id": sid, "count": 4, "seed": 42017, "robot_id": "industrial_6r"}
        assert client.post("/api/workcells/warehouse", json=payload).status_code == 401
        response = client.post("/api/workcells/warehouse", headers=headers, json=payload)
        assert response.status_code == 200, response.text
        preview = response.json()
        assert preview["executed"] is False and len(preview["scenarios"]) == 4
        state = client.get(f"/api/sessions/{sid}", headers=headers).json()
        assert state["run_mode"] == "scenario_preview" and not state["running"]
        assert state["world"]["robot"]["kinematics_kind"] == "six_dof_kinematic"
        assert state["world"]["step"] == 0 and state["result"] is None
        assert state["task"]["target_id"] == "parcel_00"
        assert not list(runtime.storage.path("episodes").glob("*/result.json"))
        case = runtime.storage.load(f"scenarios/{preview['preview_case_id']}.json")
        assert canonical_hash(case) == canonical_hash(warehouse_cases(4, 42017)[0])
        obstruction = preview["scenarios"][1]
        switched = client.post("/api/workcells/scenario", headers=headers, json={"session_id": sid, "case_id": obstruction["case_id"]})
        assert switched.status_code == 200 and switched.json()["executed"] is False
        state = client.get(f"/api/sessions/{sid}", headers=headers).json()
        assert state["case_id"] == obstruction["case_id"] and state["world"]["step"] == 0
        assert len(state["world"]["obstacles"]) == 6
        restored = client.post("/api/workcells/camera", headers=headers, json={"session_id": sid})
        assert restored.status_code == 200
        state = client.get(f"/api/sessions/{sid}", headers=headers).json()
        assert state["world"] is None and state["result"] is None


def test_robot_variants_are_different_immutable_cases(tmp_path, monkeypatch):
    module = importlib.import_module("backend.app")
    monkeypatch.setattr(module, "runtime", Runtime(Storage(tmp_path)))
    with TestClient(module.app) as client:
        session = client.post("/api/camera/session").json()
        headers = {"Authorization": "Bearer " + session["token"]}
        payload = {"session_id": session["session_id"], "count": 1, "robot_id": "compact_6r"}
        response = client.post("/api/workcells/warehouse", headers=headers, json=payload)
        assert response.status_code == 200
        case = response.json()["scenarios"][0]
        assert case["case_id"].endswith("compact_6r")
        assert case["provenance"]["robot_profile"] == "compact_6r"
        catalog = client.get("/api/health").json()["robots"]
        assert len(catalog) == 3 and all(r["policy_independent"] for r in catalog)


def test_observed_blocked_target_escalation_is_not_completion(tmp_path):
    case = warehouse_cases(4)[3]
    result, _ = asyncio.run(run_case(case, "scripted_obstacle_aware", Storage(tmp_path)))
    assert result.outcome == "ESCALATED" and result.reason == "APPROPRIATE_HELP"
    assert not result.task_success and not result.constraint_violations
