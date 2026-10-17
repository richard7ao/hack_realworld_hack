"""MockTransport contract tests, never evidence of real frontier-model runs."""
import asyncio
import json

import httpx
import pytest

from backend import policies
from backend.generator import sanity_case
from backend.runner import run_case
from backend.storage import Storage


@pytest.fixture
def mocked_provider(monkeypatch):
    # Never load the user's real .env or send a network request in this suite.
    monkeypatch.setattr(policies, "reload_config", lambda: None)
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-openai-credential")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-only-anthropic-credential")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    original_client = httpx.AsyncClient

    def install(handler):
        transport = httpx.MockTransport(handler)
        monkeypatch.setattr(policies.httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport, **kwargs))

    return install


def provider_response(model, action, identity="mock_response_1"):
    text = json.dumps(action) if isinstance(action, dict) else action
    if model.startswith("claude"):
        return {"id": identity, "model": model, "stop_reason": "end_turn",
                "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 20, "output_tokens": 10}}
    return {"id": identity, "model": model, "status": "completed", "output": [{"type": "message",
        "content": [{"type": "output_text", "text": text}]}], "usage": {"input_tokens": 20, "output_tokens": 10}}


@pytest.mark.parametrize("model", ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"])
def test_requested_frontier_ids_use_typed_adapter_without_substitution(model, mocked_provider, tmp_path):
    case = sanity_case(family="none")
    target = case.initial_scene.objects[0]
    actions = [
        {"type": "MOVE_TO", "position": target.position},
        {"type": "GRASP", "target_id": target.id, "position": target.position},
        {"type": "MOVE_TO", "position": (*target.position[:2], .25)},
        {"type": "MOVE_TO", "position": (*case.destination.center[:2], .25)},
        {"type": "MOVE_TO", "position": case.destination.center},
        {"type": "PLACE", "target_id": case.destination.id},
        {"type": "DONE"},
    ]
    requests = []

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        assert payload["model"] == model
        if model.startswith("claude"):
            assert request.url.path == "/v1/messages"
            assert request.headers["anthropic-version"] == "2023-06-01"
            data = json.loads(payload["messages"][0]["content"])
            assert payload["output_config"]["format"]["type"] == "json_schema"
        else:
            assert request.url.path == "/v1/responses"
            data = json.loads(payload["input"])
            assert payload["text"]["format"]["strict"] is True
        assert set(data) == {"capabilities", "observation", "recent_actions"}
        assert "disturbances" not in data["observation"]
        assert "world" not in data["observation"]
        assert "scenario" not in data["observation"]
        assert all("authority" not in obj for obj in data["observation"]["detected_objects"])
        action = {"target_id": None, "position": None, "reason": "Mock transport fixture", "max_execution_ms": 3000,
                  **actions[len(requests) - 1]}
        return httpx.Response(200, json=provider_response(model, action, f"mock_response_{len(requests)}"))

    mocked_provider(handler)
    result, env = asyncio.run(run_case(case, model, Storage(tmp_path)))
    assert result.outcome == "PASS" and result.verified
    assert result.policy.model == result.policy.policy_id == model
    assert result.policy.adapter_type == "symbolic_tool_agent"
    assert result.policy.deterministic is False
    assert result.model_calls == len(requests) == result.actions == 7
    decisions = [event for event in env.events if event.kind == "policy.decision"]
    assert len(decisions) == 7
    assert {event.data["provider_response"]["requested_model"] for event in decisions} == {model}
    assert {event.data["provider_response"]["response_model"] for event in decisions} == {model}
    assert all(event.data["provider_response"]["response_id"].startswith("mock_response_") for event in decisions)
    assert all(event.data["provider_response"]["usage"]["output_tokens"] == 10 for event in decisions)
    assert result.wall_elapsed_ms >= result.inference_elapsed_ms >= 0
    assert result.sim_elapsed_ms > 0


@pytest.mark.parametrize("model", ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"])
@pytest.mark.parametrize("bad_action", ["not JSON", '{"type":"ASSERT_SUCCESS"}', '{"type":"MOVE_TO","position":[NaN,0,0]}'])
def test_malformed_provider_output_is_unknown_without_scripted_fallback(model, bad_action, mocked_provider, tmp_path):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=provider_response(model, bad_action))

    mocked_provider(handler)
    result, env = asyncio.run(run_case(sanity_case(), model, Storage(tmp_path)))
    assert result.outcome == "UNKNOWN" and not result.task_success
    assert result.reason.startswith("POLICY_ERROR:")
    assert result.model_calls == len(requests) == 1
    assert result.actions == 0
    assert any(event.kind == "policy.error" for event in env.events)
    assert not any(event.kind == "executor.action_result" for event in env.events)
    assert env.events[-1].data["outcome"] == "UNKNOWN"
    assert Storage(tmp_path).load(f"episodes/{result.episode_id}/result.json")["policy"]["model"] == model


@pytest.mark.parametrize("model", ["gpt-6.1-sol", "claude-opus-5-5"])
def test_provider_timeout_is_durably_timeout_without_substitution(model, mocked_provider, tmp_path):
    def handler(request):
        raise httpx.ReadTimeout("Mock provider read timeout", request=request)

    mocked_provider(handler)
    store = Storage(tmp_path)
    result, env = asyncio.run(run_case(sanity_case(), model, store))
    assert result.outcome == "TIMEOUT" and result.reason == "POLICY_TIMEOUT"
    assert result.actions == 0 and result.model_calls == 1
    assert result.policy.model == model and not result.task_success
    assert any(event.kind == "policy.timeout" for event in env.events)
    assert store.load(f"episodes/{result.episode_id}/result.json")["outcome"] == "TIMEOUT"


@pytest.mark.parametrize("status", [400, 401, 429, 500])
def test_provider_http_error_has_no_fabricated_actions(status, mocked_provider, tmp_path):
    mocked_provider(lambda request: httpx.Response(status, json={"error": {"message": "Mock provider unavailable"}}))
    result, env = asyncio.run(run_case(sanity_case(), "gpt-6.1-sol", Storage(tmp_path)))
    assert result.outcome == "UNKNOWN" and result.actions == 0 and result.model_calls == 1
    assert any(str(status) in event.data.get("error", "") for event in env.events if event.kind == "policy.error")


def test_missing_key_fails_explicitly_and_never_chooses_an_older_model(monkeypatch):
    monkeypatch.setattr(policies, "reload_config", lambda: None)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    for model in ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"]:
        with pytest.raises(ValueError, match="Missing"):
            policies.make_policy(model)
    assert not any(item["available"] for item in policies.policy_catalog() if item["kind"] == "frontier")


def test_provider_error_cannot_echo_credentials_into_evidence(mocked_provider, tmp_path):
    secret = "test-only-openai-credential"
    mocked_provider(lambda request: httpx.Response(401, json={"error": {"message": "Invalid API key " + secret}}))
    result, _ = asyncio.run(run_case(sanity_case(), "gpt-6.1-sol", Storage(tmp_path)))
    assert result.outcome == "UNKNOWN"
    assert secret not in Storage(tmp_path).path(result.trace_ref).read_text()
