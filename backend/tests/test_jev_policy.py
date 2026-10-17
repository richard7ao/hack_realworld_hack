"""Pre-action Jev assistance contracts; all provider replies are unit fixtures."""
import asyncio
import json

import httpx
import pytest

from backend import jev, policies
from backend.engine import Environment
from backend.generator import sanity_case
from backend.jev_policy import ASSISTED_MODELS
from backend.models import PolicyAction
from backend.runner import run_case
from backend.storage import Storage


@pytest.fixture(autouse=True)
def isolated_credentials(monkeypatch):
    monkeypatch.setattr(jev, "reload_config", lambda: None)
    monkeypatch.setattr(policies, "reload_config", lambda: None)
    monkeypatch.setenv("JEV_API_KEY", "unit-test-jev-key")
    monkeypatch.setenv("OPENAI_API_KEY", "unit-test-openai-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "unit-test-anthropic-key")
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")


def guidance_answers(intent="REOBSERVE"):
    return {"cause": {"type": "choice", "choice": "stale_pose", "confidence": .91,
        "probabilities": {k: float(k == "stale_pose") for k in jev.MANIPULATION_CAUSES}},
        "recommended_intent": {"type": "choice", "choice": intent, "confidence": .92,
            "probabilities": {k: float(k == intent) for k in jev.MANIPULATION_INTENTS}},
        "unsafe_to_repeat": {"type": "noul", "noul": .93}}


def observation():
    case = sanity_case()
    env = Environment("unit_episode")
    return case, env.reset(case, case.seed)


def mock_network(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))


def typed_response(answers):
    return {"model": "jev-1.14.0", "answers": answers, "usage": {"input_tokens": 100, "output_tokens": 50}}


def frontier_response(model, action):
    text = json.dumps(action)
    usage = {"input_tokens": 150, "output_tokens": 70}
    if model.startswith("claude"):
        return {"id": "unit_frontier_reply", "model": model, "content": [{"type": "text", "text": text}], "usage": usage}
    return {"id": "unit_frontier_reply", "model": model, "output": [{"content": [{"type": "output_text", "text": text}]}], "usage": usage}


@pytest.mark.parametrize("policy_id,model", ASSISTED_MODELS.items())
def test_current_guidance_is_consumed_by_exact_frontier_without_action_override(policy_id, model, monkeypatch):
    case, obs = observation()
    obs.robot.native_physics = {"jaw_closed_fraction": .2, "contact_count": 2, "initial_objects": [{"hidden_pose": "NEVER_SEND"}]}
    obs.last_action_result.details = {"native_physics": {"initial_objects": ["NEVER_SEND"]}, "operator_note": "retain"}
    before = obs.model_dump_json()
    requests = []
    # Deliberately make frontier choose WAIT while Jev advises REOBSERVE;
    # the wrapper must expose guidance without overriding the action.
    action = PolicyAction(type="WAIT", reason="Unit frontier independently selected a wait").model_dump(mode="json")
    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        assert "NEVER_SEND" not in request.content.decode()
        if request.url.host == "api.typesafe.ai":
            assert payload["model"] == "jev-1.14.0"
            state = payload["state"]
            assert "future_disturbances" not in state and "world" not in state
            assert set(state["last_action_result"]) == {"status", "reason", "action_type"}
            assert state["robot"]["jaw_closed_fraction"] == .2
            assert state["robot"]["contact_summary"]["native_contact_count"] == 0
            assert "assets" not in payload
            return httpx.Response(200, json=typed_response(guidance_answers()))
        assert len(requests) == 2 and payload["model"] == model
        sent = json.loads(payload["messages"][0]["content"] if model.startswith("claude") else payload["input"])
        forwarded = sent["observation"]["last_action_result"]["details"]["jev_guidance"]
        assert forwarded["recommended_intent"]["choice"] == "REOBSERVE"
        assert forwarded["model"] == "jev-1.14.0"
        return httpx.Response(200, json=frontier_response(model, action))
    mock_network(monkeypatch, handler)
    adapter = policies.make_policy(policy_id)
    adapter.reset(case.task, {"safe_travel_height": .25, "hidden_world": "NEVER_SEND"})
    # Capabilities are supplied by the environment and base FrontierPlanner sees
    # them; use only genuine public capabilities for this transport assertion.
    adapter.capabilities.pop("hidden_world")
    chosen = asyncio.run(adapter.predict(obs))
    assert chosen.type == "WAIT" and obs.model_dump_json() == before
    assert adapter.calls == 2
    assert adapter.manifest.model == model and adapter.manifest.policy_id == policy_id
    record = adapter.inference_record
    assert record["response_model"] == model
    assert record["jev_assistance"]["response_model"] == "jev-1.14.0"
    assert record["jev_assistance"]["request"]["state"]["step"] == obs.step
    assert record["model_call_counts"] == {"jev": 1, "frontier": 1}


def test_manipulation_state_whitelists_current_belief_and_public_capabilities():
    _, obs = observation()
    obs.robot.native_physics = {"initial_objects": ["SECRET_NATIVE_POSE"], "jaw_closed_fraction": .5}
    obs.last_action_result.details = {"ground_truth": "SECRET_NATIVE_POSE", "future_disturbances": ["future"]}
    state = jev.manipulation_state(obs, PolicyAction(type="OBSERVE"), {"safe_travel_height": .25, "future_schedule": "SECRET_NATIVE_POSE"})
    assert "SECRET_NATIVE_POSE" not in json.dumps(state)
    assert state["observed_at_step"] == obs.observed_at_step
    assert state["observed_objects"][0]["position"] == list(obs.detected_objects[0].position)
    assert state["public_capabilities"] == {"safe_travel_height": .25}
    assert state["last_action"]["type"] == "OBSERVE"


def test_missing_jev_key_disables_assisted_catalog_and_fails_explicitly(monkeypatch):
    monkeypatch.delenv("JEV_API_KEY")
    assert not any(row["available"] for row in policies.policy_catalog() if row["id"].startswith("jev_"))
    assert next(row for row in policies.policy_catalog() if row["id"] == "gpt-6.1-sol")["available"]
    with pytest.raises(ValueError, match="requires JEV"):
        policies.make_policy("jev_gpt-6.1-sol")


def test_guidance_failure_stops_episode_without_calling_frontier(monkeypatch, tmp_path):
    hosts = []
    def handler(request):
        hosts.append(request.url.host)
        return httpx.Response(429, text="unit-test-jev-key")
    mock_network(monkeypatch, handler)
    result, env = asyncio.run(run_case(sanity_case(), "jev_gpt-6.1-sol", Storage(tmp_path)))
    assert result.outcome == "UNKNOWN" and result.reason.startswith("POLICY_ERROR")
    assert result.actions == 0 and result.model_calls == 1
    assert hosts == ["api.typesafe.ai"]
    assert "unit-test-jev-key" not in Storage(tmp_path).path(result.trace_ref).read_text()


def test_malformed_manipulation_reply_never_reaches_frontier(monkeypatch):
    _, obs = observation()
    answers = guidance_answers()
    answers["recommended_intent"]["choice"] = "ASSERT_SUCCESS"
    mock_network(monkeypatch, lambda r: httpx.Response(200, json=typed_response(answers)))
    with pytest.raises(jev.JevError, match="guidance invalid"):
        asyncio.run(jev.advise_manipulation(obs))


def test_every_executed_decision_persists_actual_guidance_and_both_provider_counts(monkeypatch, tmp_path):
    def handler(request):
        if request.url.host == "api.typesafe.ai":
            return httpx.Response(200, json=typed_response(guidance_answers("REQUEST_HELP")))
        payload = json.loads(request.content)
        return httpx.Response(200, json=frontier_response(payload["model"], PolicyAction(type="REQUEST_HELP", reason="Unit fixture escalation").model_dump(mode="json")))
    mock_network(monkeypatch, handler)
    result, env = asyncio.run(run_case(sanity_case(), "jev_gpt-6.1-sol", Storage(tmp_path)))
    assert result.outcome == "ESCALATED" and result.model_calls == 2
    decisions = [e for e in env.events if e.kind == "policy.decision"]
    assert len(decisions) == 1
    assistance = decisions[0].data["provider_response"]["jev_assistance"]
    assert assistance["request"]["state"]["episode_id"] == result.episode_id
    assert assistance["raw_validated_response"]["answers"]["recommended_intent"]["choice"] == "REQUEST_HELP"
