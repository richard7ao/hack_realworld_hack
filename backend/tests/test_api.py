"""Transport integration tests; all image inputs here are generated test fixtures.

These verify executable contracts and persisted evidence, not physical-camera or
real-model benchmark claims.
"""
import importlib
import json
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.generator import sanity_case
from backend.models import Disturbance
from backend.runtime import Runtime
from backend.storage import Storage, canonical_hash


@pytest.fixture
def api(tmp_path, monkeypatch):
    module = importlib.import_module("backend.app")
    runtime = Runtime(Storage(tmp_path))
    monkeypatch.setattr(module, "runtime", runtime)
    with TestClient(module.app) as client:
        yield client, runtime


def make_session(client):
    response = client.post("/api/camera/session")
    assert response.status_code == 200, response.text
    session = response.json()
    return session["session_id"], {"Authorization": "Bearer " + session["token"]}, session["token"]


def fixture_jpeg(target_x=100):
    """Three unmarked coloured rectangles on a generated image, not a camera."""
    frame = np.full((480, 640, 3), 220, dtype=np.uint8)
    for x, y, color in [(target_x, 100, (20, 30, 210)), (320, 100, (20, 180, 40)), (100, 300, (210, 40, 20))]:
        cv2.rectangle(frame, (x, y), (x + 50, y + 30), color, -1)
    return cv2.imencode(".jpg", frame)[1].tobytes()


def post_frame(client, sid, headers, seq, image=None, timestamp=None):
    return client.post(f"/api/camera/{sid}/frame", params={"seq": seq, "timestamp_ms": seq * 200 if timestamp is None else timestamp},
                       headers={**headers, "Content-Type": "image/jpeg"}, content=image or fixture_jpeg())


def prepare_capture(client, sid, headers):
    assert post_frame(client, sid, headers, 1).status_code == 200
    response = client.post("/api/workcell/calibration", headers=headers, json={"session_id": sid,
        "calibration": {"corners": [[0, 0], [640, 0], [640, 480], [0, 480]]}})
    assert response.status_code == 200, response.text
    for identity, x, y in [("chocolate_A", 100, 100), ("carton_B", 320, 100), ("highlighter_C", 100, 300)]:
        response = client.post("/api/objects/seed", headers=headers, json={"session_id": sid, "id": identity,
            "label": identity, "bbox": [x + 3, y + 3, 44, 24]})
        assert response.status_code == 200, response.text


def await_state(client, sid, headers, predicate, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/sessions/{sid}", headers=headers)
        assert response.status_code == 200, response.text
        state = response.json()
        if predicate(state):
            return state
        time.sleep(0.005)
    pytest.fail(f"Session did not reach expected state: {state}")


def test_camera_session_authentication_and_expiry(api):
    client, runtime = api
    sid, headers, _ = make_session(client)
    assert client.get(f"/api/sessions/{sid}").status_code == 401
    assert post_frame(client, sid, {}, 1).status_code == 401
    assert post_frame(client, sid, {"Authorization": "Bearer wrong"}, 1).status_code == 401
    assert not list(runtime.storage.path("frames").rglob("*.jpg"))
    assert client.get(f"/api/sessions/{sid}", headers=headers).json()["camera_status"] == "CAMERA_DISCONNECTED"
    runtime.sessions[sid].expires_at = time.time() - 1
    assert post_frame(client, sid, headers, 1).status_code == 401


def test_real_ingest_calibration_and_three_selected_objects(api):
    client, runtime = api
    sid, headers, _ = make_session(client)
    calibration = {"session_id": sid, "calibration": {"corners": [[0, 0], [640, 0], [640, 480], [0, 480]], "width": 0.6, "depth": 0.4}}
    assert client.post("/api/workcell/calibration", headers=headers, json=calibration).status_code == 422
    assert post_frame(client, sid, headers, 1).status_code == 200
    response = client.post("/api/workcell/calibration", headers=headers, json=calibration)
    assert response.json()["coordinate_frame"] == "workcell_m"
    assert response.json()["workspace"] == [0.6, 0.4]
    for identity, x, y in [("chocolate_A", 100, 100), ("carton_B", 320, 100), ("highlighter_C", 100, 300)]:
        response = client.post("/api/objects/seed", headers=headers, json={"session_id": sid, "id": identity,
            "label": identity, "bbox": [x + 3, y + 3, 44, 24], "dimensions": [0.06, 0.03, 0.04]})
        assert response.status_code == 200, response.text
    state = client.get(f"/api/sessions/{sid}", headers=headers).json()
    assert len(state["observed"]["objects"]) == 3
    assert state["observed"]["objects"][0]["position"][:2] == pytest.approx([125 / 640 * .6, 115 / 480 * .4])
    assert state["camera_status"] == "CONNECTED"
    assert runtime.storage.path(state["observed"]["frame_ref"]).read_bytes() == fixture_jpeg()
    moved = post_frame(client, sid, headers, 2, fixture_jpeg(240)).json()["observed"]
    assert moved["objects"][0]["position"][0] > state["observed"]["objects"][0]["position"][0] + .1
    assert moved["objects"][0]["confidence"] > .8


def test_rejected_frames_never_overwrite_last_accepted_evidence(api):
    client, runtime = api
    sid, headers, _ = make_session(client)
    assert post_frame(client, sid, headers, 1).status_code == 200
    path = runtime.storage.path(f"frames/{sid}/00000001.jpg")
    original = path.read_bytes()
    response = post_frame(client, sid, headers, 1, fixture_jpeg(240), timestamp=400)
    assert response.status_code == 422 and "STALE_FRAME" in response.text
    assert post_frame(client, sid, headers, 2, b"not a jpeg").status_code == 422
    assert post_frame(client, sid, headers, 3, b"x" * 1_500_001).status_code == 413
    assert path.read_bytes() == original
    assert not runtime.storage.path(f"frames/{sid}/00000002.jpg").exists()
    assert client.get(f"/api/sessions/{sid}", headers=headers).json()["observed"]["seq"] == 1


@pytest.mark.parametrize("timestamp", ["inf", "-inf", "nan"])
def test_nonfinite_frame_timestamp_cannot_poison_camera_session(api, timestamp):
    client, _ = api
    sid, headers, _ = make_session(client)
    assert post_frame(client, sid, headers, 1).status_code == 200
    invalid = post_frame(client, sid, headers, 2, timestamp=timestamp)
    assert invalid.status_code == 422
    # Rejected metadata must not mutate the tracker into a permanently stale
    # state or consume seq=2; a valid retry remains usable.
    valid = post_frame(client, sid, headers, 2, timestamp=400)
    assert valid.status_code == 200, valid.text


def test_websocket_camera_requires_token_and_accepts_sequenced_jpeg(api):
    client, _ = api
    sid, _, token = make_session(client)
    with client.websocket_connect(f"/ws/camera/{sid}") as ws:
        ws.send_json({"token": "incorrect"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4401
    with client.websocket_connect(f"/ws/camera/{sid}") as ws:
        ws.send_json({"token": token})
        ws.send_json({"seq": 1, "timestamp_ms": 200})
        ws.send_bytes(fixture_jpeg())
        event = ws.receive_json()
        assert event["kind"] == "observed.scene" and event["data"]["seq"] == 1
        ws.send_json({"seq": 1, "timestamp_ms": 400})
        ws.send_bytes(fixture_jpeg())
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4400


def test_no_synthetic_fallback_for_unavailable_live_capture(api):
    client, runtime = api
    sid, headers, _ = make_session(client)
    response = client.post("/api/policy/run", headers=headers, json={"session_id": sid, "delay_seconds": 0})
    assert response.status_code == 422
    assert not list(runtime.storage.path("episodes").iterdir())
    assert client.get("/api/episodes/ep_missing").status_code == 404
    assert client.get("/api/scenarios/CAPTURE-missing").status_code == 404
    assert client.post("/api/scenarios/from-live", headers=headers, json={"session_id": sid, "confirmed": True}).status_code == 422


def test_fresh_rerun_persists_decisions_and_independent_result(api):
    client, runtime = api
    sid, headers, _ = make_session(client)
    case = sanity_case()
    runtime.storage.save_scenario(case)
    episodes = []
    for policy in ["scripted_open_loop", "scripted_reobserve"]:
        response = client.post(f"/api/replays/{case.case_id}/rerun", headers=headers,
            json={"session_id": sid, "policy_id": policy, "delay_seconds": 0})
        assert response.status_code == 200, response.text
        state = await_state(client, sid, headers, lambda state: not state["running"])
        assert state["error"] is None
        episode = client.get("/api/episodes/" + state["result"]["episode_id"]).json()
        assert episode["result"]["verified"] is True
        assert episode["result"]["scenario_hash"] == canonical_hash(case)
        assert episode["result"]["actions"] == sum(event["kind"] == "executor.action_result" for event in episode["events"])
        assert episode["events"][-1]["kind"] == "benchmark.case_finished"
        assert [event["seq"] for event in episode["events"]] == list(range(1, len(episode["events"]) + 1))
        assert any(event["kind"] == "policy.observation" for event in episode["events"])
        assert any(event["kind"] == "policy.decision" for event in episode["events"])
        disk = [json.loads(line) for line in runtime.storage.path(episode["result"]["trace_ref"]).read_text().splitlines()]
        assert disk == episode["events"]
        episodes.append(episode)
    assert episodes[0]["result"]["outcome"] == "FAIL"
    assert episodes[0]["result"]["reason"] == "TARGET_DISPLACED"
    assert episodes[1]["result"]["outcome"] == "PASS"
    assert episodes[0]["result"]["episode_id"] != episodes[1]["result"]["episode_id"]


def test_observed_disturbance_compiles_and_reruns_identical_hash(api):
    client, runtime = api
    sid, headers, _ = make_session(client)
    prepare_capture(client, sid, headers)
    response = client.post("/api/policy/run", headers=headers,
        json={"session_id": sid, "policy_id": "scripted_open_loop", "delay_seconds": .15})
    assert response.status_code == 200, response.text
    await_state(client, sid, headers, lambda s: s["world"] is not None and s["world"]["step"] == 1)
    assert post_frame(client, sid, headers, 2, fixture_jpeg(240)).status_code == 200
    finished = await_state(client, sid, headers, lambda s: not s["running"])
    assert finished["result"]["reason"] == "TARGET_DISPLACED"
    original_episode = finished["result"]["episode_id"]
    assert client.post("/api/scenarios/from-live", headers=headers, json={"session_id": sid}).status_code == 422
    response = client.post("/api/scenarios/from-live", headers=headers,
        json={"session_id": sid, "name": "Generated image fixture regression", "confirmed": True})
    assert response.status_code == 200, response.text
    captured = response.json()
    case = captured["scenario"]
    assert case["disturbances"][0]["source"] == "camera_observed"
    assert case["disturbances"][0]["after_action_index"] == 1
    assert case["disturbances"][0]["frame_ref"] == f"frames/{sid}/00000002.jpg"
    assert case["provenance"]["capture_episode_id"] == original_episode
    assert captured["scenario_hash"] == canonical_hash(case)
    assert client.get(f"/api/scenarios/{case['case_id']}").json() == case
    # Fresh executions do not need another image or a human disturbance.
    response = client.post("/api/benchmarks/run", headers=headers, json={"session_id": sid,
        "case_ids": [case["case_id"]], "gate": {"minimum_cases": 1, "completion_threshold": 1}})
    assert response.status_code == 200, response.text
    run_id = response.json()["id"]
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        bench = client.get(f"/api/benchmarks/{run_id}").json()
        if bench["status"] != "RUNNING":
            break
        time.sleep(.005)
    assert bench["status"] == "DONE", bench
    assert bench["completed_executions"] == bench["total_executions"] == 2
    assert [r["outcome"] for r in bench["results"]] == ["FAIL", "PASS"]
    assert {r["scenario_hash"] for r in bench["results"]} == {captured["scenario_hash"]}
    assert len({r["episode_id"] for r in bench["results"]} | {original_episode}) == 3
    assert bench["gate"]["fixes"] == [case["case_id"]]
    assert bench["gate"]["verdict"] == "PASS"
    assert runtime.storage.load(f"benchmarks/{run_id}.json")["completed_executions"] == 2


def test_session_token_cannot_read_another_cameras_frame(api):
    client, _ = api
    a, a_headers, _ = make_session(client)
    b, b_headers, _ = make_session(client)
    assert post_frame(client, a, a_headers, 1).status_code == 200
    own = client.get(f"/api/evidence/frames/{a}/00000001.jpg", headers=a_headers, params={"session_id": a})
    assert own.status_code == 200
    other = client.get(f"/api/evidence/frames/{a}/00000001.jpg", headers=b_headers, params={"session_id": b})
    assert other.status_code in {403, 404}


def test_saved_capture_rerun_ignores_new_camera_updates(api):
    client, runtime = api
    sid, headers, _ = make_session(client)
    prepare_capture(client, sid, headers)
    case = runtime.live_scenario(runtime.sessions[sid], "chocolate_A")
    case.case_id = "CAPTURE-fixture-isolation"
    case.disturbances = [Disturbance(type="MOVE_OBJECT", object_id="chocolate_A", position=(.55, .5, .02),
        after_action_index=1, source="camera_observed", frame_ref=f"frames/{sid}/00000002.jpg")]
    runtime.storage.save_scenario(case)
    response = client.post(f"/api/replays/{case.case_id}/rerun", headers=headers,
        json={"session_id": sid, "policy_id": "scripted_reobserve", "delay_seconds": .06})
    assert response.status_code == 200, response.text
    state = await_state(client, sid, headers, lambda s: s["world"] is not None and s["world"]["step"] == 1)
    assert state["run_mode"] == "scenario_rerun"
    assert post_frame(client, sid, headers, 3, fixture_jpeg(180)).status_code == 200
    state = await_state(client, sid, headers, lambda s: not s["running"])
    assert state["result"]["outcome"] == "PASS"
    assert state["result"]["scenario_hash"] == canonical_hash(case)
    assert state["live_disturbances"] == []
    episode = client.get(f"/api/episodes/{state['result']['episode_id']}").json()
    disturbances = [event for event in episode["events"] if event["kind"] == "disturbance.detected"]
    assert len(disturbances) == 1
    assert disturbances[0]["data"]["disturbance"]["position"] == [.55, .5, .02]


def test_camera_disconnect_during_live_run_is_unknown_and_durable(api):
    client, runtime = api
    sid, headers, _ = make_session(client)
    prepare_capture(client, sid, headers)
    response = client.post("/api/policy/run", headers=headers,
        json={"session_id": sid, "policy_id": "scripted_open_loop", "delay_seconds": .1})
    assert response.status_code == 200, response.text
    await_state(client, sid, headers, lambda s: s["world"] is not None and s["world"]["step"] == 1)
    # Simulate elapsed receive time, without waiting three real seconds.
    runtime.sessions[sid].tracker.received_at = time.time() - 4
    state = await_state(client, sid, headers, lambda s: not s["running"])
    assert state["camera_status"] == "CAMERA_DISCONNECTED"
    assert state["result"]["outcome"] == "UNKNOWN"
    assert "CAMERA_DISCONNECTED" in state["result"]["reason"]
    assert not state["result"]["task_success"]
    assert state["result"]["actions"] == 1
    episode = client.get(f"/api/episodes/{state['result']['episode_id']}").json()
    assert episode["events"][-1]["data"]["outcome"] == "UNKNOWN"
    assert post_frame(client, sid, headers, 2).status_code == 200
    assert client.get(f"/api/sessions/{sid}", headers=headers).json()["camera_status"] == "CONNECTED"
    assert client.get(f"/api/episodes/{state['result']['episode_id']}").json() == episode


def test_virtual_injection_is_not_misreported_as_observed_physical_motion(api):
    client, _ = api
    sid, headers, _ = make_session(client)
    prepare_capture(client, sid, headers)
    response = client.post("/api/policy/run", headers=headers,
        json={"session_id": sid, "policy_id": "scripted_open_loop", "delay_seconds": .1})
    assert response.status_code == 200, response.text
    await_state(client, sid, headers, lambda s: s["world"] is not None and s["world"]["step"] == 1)
    response = client.post("/api/disturbances/inject", headers=headers, json={"session_id": sid,
        "disturbance": {"type": "MOVE_OBJECT", "object_id": "chocolate_A", "position": [.55, .5, .02],
                        "after_action_index": 999, "source": "camera_observed"}})
    assert response.status_code == 200, response.text
    assert response.json()["disturbance"]["source"] == "operator_injected"
    assert response.json()["disturbance"]["after_action_index"] == 1
    assert post_frame(client, sid, headers, 2).status_code == 200
    state = await_state(client, sid, headers, lambda s: not s["running"])
    assert state["run_mode"] == "operator_injected"
    assert state["result"]["reason"] == "TARGET_DISPLACED"
    assert len(state["live_disturbances"]) == 1
    response = client.post("/api/scenarios/from-live", headers=headers, json={"session_id": sid, "confirmed": True})
    assert response.status_code == 200, response.text
    assert response.json()["scenario"]["source"] == "operator_defined"
