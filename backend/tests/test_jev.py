"""Jev HTTP contract tests. Mock replies are not evidence of live model access."""
import asyncio
import json

import cv2
import httpx
import numpy as np
import pytest

from backend import jev
from backend.generator import sanity_case


@pytest.fixture(autouse=True)
def no_real_credentials(monkeypatch):
    monkeypatch.setattr(jev, "reload_config", lambda: None)
    monkeypatch.setenv("JEV_API_KEY", "test-only-jev-credential")
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)


def response(answers):
    return {"model": jev.JEV_MODEL, "answers": answers, "usage": {"input_tokens": 200, "output_tokens": 50}}


def triage_answers():
    return {"cause": {"type": "choice", "choice": "stale_target_pose", "confidence": .9,
        "probabilities": {k: float(k == "stale_target_pose") for k in jev.CAUSES}},
        "reobserve": {"type": "noul", "noul": .97},
        "severity": {"type": "score", "score": 2., "confidence": .9,
            "legend": {str(i): s for i, s in enumerate(jev.SEVERITY)},
            "probabilities": {"0": 0., "1": 0., "2": 1., "3": 0.}}}


def grounding_answers():
    return {"object_0_visible": {"type": "noul", "noul": .95},
        "object_0_box": {"type": "box", "box": {"left": .1, "right": .6, "top": .2, "bottom": .8}, "confidence": .8}}


def fixture_episode():
    case = sanity_case().model_dump(mode="json")
    result = {"episode_id": "test_episode", "outcome": "FAIL", "reason": "TARGET_DISPLACED", "verified": True,
              "constraint_violations": [], "actions": 3}
    events = [{"seq": 1, "kind": "executor.action_result", "sim_elapsed_ms": 800,
               "data": {"status": "rejected", "reason": "TARGET_DISPLACED"}}]
    return case, result, events


def jpeg(width=320, height=300):
    return cv2.imencode(".jpg", np.full((height, width, 3), 200, np.uint8))[1].tobytes()


def run_with(handler, operation):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await operation(client)
    return asyncio.run(run())


def test_typed_triage_posts_actual_structured_episode_and_records_provenance():
    case, result, events = fixture_episode()
    before = json.dumps([case, result, events], sort_keys=True)
    def handler(request):
        assert str(request.url) == jev.JEV_ENDPOINT
        assert "TypeSafe-Danger-Zone-Images" not in request.headers
        payload = json.loads(request.content)
        assert payload["model"] == "jev-1.14.0"
        assert set(payload["questions"]) == {"cause", "reobserve", "severity"}
        assert payload["state"]["independent_result"]["reason"] == "TARGET_DISPLACED"
        assert payload["state"]["execution_events"][0]["data"] == events[0]["data"]
        return httpx.Response(200, json=response(triage_answers()))
    report = run_with(handler, lambda c: jev.triage_episode(case, result, events, client=c))
    assert report["advisory_only"] and not report["changes_oracle"]
    assert report["response_model"] == jev.JEV_MODEL and report["wall_elapsed_ms"] >= 0
    assert report["answers"]["cause"]["choice"] == "stale_target_pose"
    assert len(report["request_sha256"]) == 64
    assert before == json.dumps([case, result, events], sort_keys=True)


def test_experimental_box_uses_multipart_opt_in_presence_and_normalized_edges():
    image = jpeg()
    def handler(request):
        assert request.headers["TypeSafe-Danger-Zone-Images"] == "true"
        assert request.headers["content-type"].startswith("multipart/form-data")
        assert b'name="request"' in request.content and b'name="tabletop-photo"' in request.content
        assert b'"model": "jev-1.14.0"' in request.content
        assert b'"object_0_visible"' in request.content
        return httpx.Response(200, json=response(grounding_answers()))
    report = run_with(handler, lambda c: jev.ground_objects(image, {"parcel": "red wrapped parcel"}, "frames/test.jpg", client=c))
    assert report["experimental"] and not report["changes_tracker"]
    assert report["scope"]["coordinate_frame"] == "uploaded_image_fraction"
    assert report["suggestions"][0]["usable_suggestion"]
    assert report["suggestions"][0]["requires_operator_confirmation"]


@pytest.mark.parametrize("edges", [
    {"left": -.1, "right": .5, "top": .2, "bottom": .6},
    {"left": .7, "right": .5, "top": .2, "bottom": .6},
    {"left": .1, "right": .5, "top": .6, "bottom": .6},
    {"left": .1, "right": 1.1, "top": .2, "bottom": .6},
    {"left": float("nan"), "right": .5, "top": .2, "bottom": .6},
])
def test_malformed_box_bounds_never_become_scene_state(edges):
    answers = grounding_answers()
    answers["object_0_box"]["box"] = edges
    # JSON cannot transport NaN; test the typed validator directly for that case.
    if any(isinstance(v, float) and np.isnan(v) for v in edges.values()):
        with pytest.raises(ValueError):
            jev.Box.model_validate(answers["object_0_box"])
        return
    with pytest.raises(jev.JevError, match="grounding response invalid"):
        run_with(lambda r: httpx.Response(200, json=response(answers)),
                 lambda c: jev.ground_objects(jpeg(), {"parcel": "parcel"}, "test.jpg", client=c))


@pytest.mark.parametrize("presence,confidence", [(0.1, .99), (.99, .1)])
def test_absent_or_uncertain_object_has_no_usable_suggestion(presence, confidence):
    answers = grounding_answers()
    answers["object_0_visible"]["noul"] = presence
    answers["object_0_box"]["confidence"] = confidence
    report = run_with(lambda r: httpx.Response(200, json=response(answers)),
                      lambda c: jev.ground_objects(jpeg(), {"parcel": "parcel"}, "test.jpg", client=c))
    assert not report["suggestions"][0]["usable_suggestion"]


@pytest.mark.parametrize("status", [400, 401, 429, 500])
def test_http_failure_does_not_echo_secret_or_submitted_state(status):
    with pytest.raises(jev.JevError) as caught:
        run_with(lambda r: httpx.Response(status, text="test-only-jev-credential sensitive state"),
                 lambda c: jev.triage_episode(*fixture_episode(), client=c))
    assert str(status) in str(caught.value)
    assert "credential" not in str(caught.value) and "sensitive" not in str(caught.value)


def test_timeout_has_no_fallback_diagnosis():
    def handler(request):
        raise httpx.ReadTimeout("test-only-jev-credential", request=request)
    with pytest.raises(jev.JevError, match="timed out"):
        run_with(handler, lambda c: jev.triage_episode(*fixture_episode(), client=c))


def test_wrong_model_and_malformed_distribution_rejected():
    bad = response(triage_answers())
    bad["model"] = "jev-1.13.0"
    with pytest.raises(jev.JevError, match="pinned"):
        run_with(lambda r: httpx.Response(200, json=bad), lambda c: jev.triage_episode(*fixture_episode(), client=c))
    bad["model"] = jev.JEV_MODEL
    bad["answers"]["cause"]["probabilities"]["stale_target_pose"] = 0.1
    with pytest.raises(jev.JevError, match="triage response invalid"):
        run_with(lambda r: httpx.Response(200, json=bad), lambda c: jev.triage_episode(*fixture_episode(), client=c))


def test_state_strips_provider_text_and_redacts_known_keys():
    case, result, events = fixture_episode()
    events += [{"kind": "policy.decision", "data": {"provider_response": "sensitive raw text"}},
               {"kind": "policy.error", "data": {"error": "test-only-jev-credential"}},
               {"kind": "executor.action_result", "data": {"reason": "test-only-jev-credential"}}]
    state = json.dumps(jev.episode_state(case, result, events))
    assert "sensitive raw text" not in state and "test-only-jev-credential" not in state
    assert "[REDACTED]" in state


def test_crop_retains_exact_source_mapping_and_minimum_padding():
    source = jpeg(640, 480)
    crop, meta = jev.crop_tabletop(source, (70, 20, 570, 310))
    assert meta["uploaded_size"] == [500, 290]
    assert meta["pixel_bounds_ltrb"] == [70, 20, 570, 310]
    assert meta["source_frame_sha256"] != meta["uploaded_jpeg_sha256"]
    assert cv2.imdecode(np.frombuffer(crop, np.uint8), 1).shape[:2] == (290, 500)
    with pytest.raises(ValueError):
        jev.crop_tabletop(source, (-1, 20, 570, 310))


def test_missing_key_and_invalid_image_fail_before_network(monkeypatch):
    monkeypatch.delenv("JEV_API_KEY")
    with pytest.raises(jev.JevError, match="Missing"):
        asyncio.run(jev.triage_episode(*fixture_episode()))
    with pytest.raises(ValueError, match="280"):
        asyncio.run(jev.ground_objects(jpeg(200, 300), {"p": "parcel"}, "test.jpg"))
