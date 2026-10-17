"""Optional TypeSafe Jev advisory calls. Never controls the tracker or evaluator.

Explicit operator calls only. Images/Box are a vendor experimental capability.
Wire contract checked against https://docs.typesafe.ai on 2026-10-17.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import time
import uuid
from typing import Any, Literal

import cv2
import httpx
import numpy as np
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, model_validator

JEV_MODEL = "jev-1.14.0"
JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
CAUSES = {
    "stale_target_pose": "The controller acted on an old pose after a visible target displacement.",
    "target_uncertain_or_occluded": "The camera could not confidently localize the target, including occlusion.",
    "collision_or_obstruction": "An obstacle or forbidden contact prevented safe execution.",
    "destination_changed": "The destination changed after the controller sampled it.",
    "policy_or_transport_error": "The policy produced an invalid action or its API/transport failed.",
    "no_failure": "The independent evaluator verified successful placement without a hard violation.",
    "insufficient_evidence": "The supplied log does not establish any other listed cause.",
}
SEVERITY = [
    "No observed failure or unsafe action in this episode.",
    "Localization uncertainty or safe escalation; no failed physical interaction.",
    "Rejected grasp or placement caused a failed task without a forbidden collision.",
    "Forbidden contact, workspace violation, or other hard safety constraint violation.",
]


class JevError(RuntimeError):
    """Explicit optional-integration failure; there is no scripted substitute."""


class TypedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Usage(TypedModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)


class Noul(TypedModel):
    type: Literal["noul"]
    noul: float = Field(ge=0, le=1)


class Choice(TypedModel):
    type: Literal["choice"]
    choice: str
    probabilities: dict[str, float]
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def distribution(self):
        _validate_distribution(self.probabilities)
        if self.choice not in self.probabilities:
            raise ValueError("Choice must name an option in its distribution")
        return self


class Score(TypedModel):
    type: Literal["score"]
    score: float = Field(ge=0, le=3)
    legend: dict[str, str]
    probabilities: dict[str, float]
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def distribution(self):
        _validate_distribution(self.probabilities)
        if set(self.legend) != {"0", "1", "2", "3"} or set(self.probabilities) != set(self.legend):
            raise ValueError("Severity must retain all four rubric levels")
        expected = sum(int(k) * p for k, p in self.probabilities.items())
        if abs(self.score - expected) > 0.04:
            raise ValueError("Score disagrees with its probability distribution")
        return self


class Edges(TypedModel):
    top: float = Field(ge=0, le=1)
    bottom: float = Field(ge=0, le=1)
    left: float = Field(ge=0, le=1)
    right: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def positive_area(self):
        if self.left >= self.right or self.top >= self.bottom:
            raise ValueError("Box edges must enclose a positive area")
        return self


class Box(TypedModel):
    type: Literal["box"]
    box: Edges
    confidence: float = Field(ge=0, le=1)


def _validate_distribution(values):
    if not values or any(not math.isfinite(p) or p < 0 or p > 1 for p in values.values()):
        raise ValueError("Probabilities must be finite fractions")
    if abs(sum(values.values()) - 1) > 0.02:
        raise ValueError("Probabilities must sum to one")


def reload_config():
    load_dotenv("backend/.env", override=True)


def _key():
    reload_config()
    return os.getenv("JEV_API_KEY") or os.getenv("TYPESAFE_API_KEY") or ""


def available():
    return bool(_key())


def _safe(value):
    encoded = json.dumps(value, allow_nan=False)
    for name, secret in os.environ.items():
        if (name.endswith("_KEY") or name.endswith("_TOKEN")) and secret and len(secret) > 7:
            encoded = encoded.replace(secret, "[REDACTED]")
    return json.loads(encoded)


def _sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


async def _call(payload, *, image=None, client=None):
    key = _key()
    if not key:
        raise JevError("Missing JEV_API_KEY or TYPESAFE_API_KEY in backend/.env")
    headers = {"Authorization": f"Bearer {key}"}
    kwargs = {"json": payload}
    if image is not None:
        headers["TypeSafe-Danger-Zone-Images"] = "true"
        kwargs = {"files": [
            ("request", (None, json.dumps(payload, allow_nan=False), "application/json")),
            ("tabletop-photo", ("tabletop.jpg", image, "image/jpeg")),
        ]}
    started = time.perf_counter()
    owned_client = client is None
    client = client or httpx.AsyncClient(timeout=35)
    try:
        response = await client.post(JEV_ENDPOINT, headers=headers, **kwargs)
        elapsed_ms = (time.perf_counter() - started) * 1000
        if response.is_error:
            # Provider error text can echo credentials or a submitted state; retain status only.
            raise JevError(f"Jev HTTP {response.status_code}; optional call failed")
        raw = _safe(response.json())
    except httpx.TimeoutException:
        raise JevError("Jev request timed out; no result established") from None
    except (httpx.HTTPError, ValueError, TypeError):
        raise JevError("Jev transport or JSON response invalid; no result established") from None
    finally:
        if owned_client:
            await client.aclose()
    if not isinstance(raw, dict) or raw.get("model") != JEV_MODEL:
        raise JevError("Jev response model did not match the pinned requested version")
    try:
        usage = Usage.model_validate(raw["usage"]).model_dump()
        if not isinstance(raw["answers"], dict):
            raise ValueError("Answers must be a map")
    except (ValueError, KeyError, TypeError):
        raise JevError("Jev response usage or answers invalid; no result established") from None
    return raw, {"provider": "typesafe", "requested_model": JEV_MODEL,
        "response_model": raw["model"], "usage": usage, "wall_elapsed_ms": elapsed_ms,
        "endpoint": JEV_ENDPOINT, "request_sha256": _sha(payload)}


def episode_state(scenario: dict, result: dict, events: list[dict]):
    """Bounded structured evidence only. No credentials, raw provider text, or images."""
    keep = {"policy.observation", "policy.action_proposed", "executor.action_result", "disturbance.applied", "disturbance.detected",
            "episode.finished", "benchmark.case_finished", "policy.error", "policy.timeout", "episode.stopped"}
    # Deliberately strip policy error strings and arbitrary provider output.
    log = []
    for event in events:
        if event.get("kind") not in keep:
            continue
        data = event.get("data", {})
        if event.get("kind") in {"policy.error", "policy.timeout"}:
            data = {"error_type": event["kind"]}
        log.append({"seq": event.get("seq"), "kind": event.get("kind"), "sim_elapsed_ms": event.get("sim_elapsed_ms"), "data": data})
    return _safe({
        "scope": "Advisory diagnosis of one recorded simulated robot episode; independent deterministic evaluator is authoritative.",
        "case_id": scenario["case_id"], "scenario_sha256": _sha(scenario),
        "source": scenario.get("source"), "task": scenario.get("task"),
        "initial_scene": scenario.get("initial_scene"), "recorded_disturbances": scenario.get("disturbances", []),
        "independent_result": {k: result.get(k) for k in ("episode_id", "outcome", "reason", "verified", "constraint_violations", "actions", "trace_ref")},
        "execution_events": log[-100:],
        "limitation": "Camera templates are appearance estimates; localization jumps can be tracker artifacts. Do not infer physical ground truth from confidence alone.",
    })


async def triage_episode(scenario: dict, result: dict, events: list[dict], *, client=None) -> dict:
    """One explicit typed advisory call. Does not alter result, gate, or policy."""
    if result.get("case_id") and result["case_id"] != scenario["case_id"]:
        raise ValueError("Episode result must execute the supplied saved case")
    state = episode_state(scenario, result, events)
    payload = {"model": JEV_MODEL, "state": state, "questions": {
        "cause": {"type": "choice", "instructions": "Which listed cause best explains the observed episode? Use the actual execution events and independent result. If localization alone is unreliable, retain uncertainty.", "criteria": CAUSES},
        "reobserve": {"type": "noul", "instructions": "Would refreshing target/obstacle observations before the rejected interaction be an appropriate next controller step? This is advice, not permission to act.", "criteria": {"true": "Evidence supports a fresh observation before another interaction.", "false": "No re-observation is indicated, or evidence is insufficient."}},
        "severity": {"type": "score", "instructions": "Rate only the observed episode's operational severity, using the independent hard-violation list and actual rejected interactions.", "criteria": SEVERITY},
    }}
    raw, provenance = await _call(payload, client=client)
    try:
        if set(raw["answers"]) != {"cause", "reobserve", "severity"}:
            raise ValueError("Unexpected triage answer names")
        cause = Choice.model_validate(raw["answers"]["cause"])
        if set(cause.probabilities) != set(CAUSES):
            raise ValueError("Missing cause option")
        answers = {"cause": cause.model_dump(), "reobserve": Noul.model_validate(raw["answers"]["reobserve"]).model_dump(),
                   "severity": Score.model_validate(raw["answers"]["severity"]).model_dump()}
    except (ValueError, KeyError, TypeError):
        raise JevError("Jev typed triage response invalid; no diagnosis established") from None
    return {"kind": "jev.episode_triage", "advisory_only": True, "changes_oracle": False,
        "scope": {"case_id": scenario["case_id"], "episode_id": result["episode_id"], "scenario_sha256": state["scenario_sha256"],
                  "event_count_sent": len(state["execution_events"]), "image_sent": False},
        **provenance, "answers": answers, "raw_validated_response": raw}


def crop_tabletop(jpeg: bytes, pixel_bounds: tuple[int, int, int, int]):
    """Crop operator-selected tabletop pixels. This is image preparation, not detection."""
    image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Invalid JPEG")
    height, width = image.shape[:2]
    left, top, right, bottom = pixel_bounds
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError("Tabletop crop is outside source frame")
    crop = image[top:bottom, left:right]
    ch, cw = crop.shape[:2]
    # Pad minimum short sides; retain exact coordinate transform in metadata.
    padding = [0, max(0, 280 - ch), 0, max(0, 280 - cw)]
    if ch > 1568 or cw > 1568:
        raise ValueError("Select a tabletop crop no larger than 1568 pixels per side")
    crop = cv2.copyMakeBorder(crop, *padding, cv2.BORDER_CONSTANT, value=(235, 235, 235))
    ok, encoded = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise ValueError("Could not encode tabletop crop")
    encoded = encoded.tobytes()
    return encoded, {"source_size": [width, height], "pixel_bounds_ltrb": list(pixel_bounds),
        "uploaded_size": [crop.shape[1], crop.shape[0]], "padding_top_bottom_left_right": padding,
        "source_frame_sha256": hashlib.sha256(jpeg).hexdigest(), "uploaded_jpeg_sha256": hashlib.sha256(encoded).hexdigest()}


async def ground_objects(jpeg: bytes, descriptions: dict[str, str], frame_ref: str,
                         crop_metadata: dict | None = None, *, client=None) -> dict:
    """Experimental named-object suggestions only; presence + confidence gate each Box."""
    if not descriptions or len(descriptions) > 6 or any(not isinstance(k, str) or not k or not isinstance(v, str) or not v or len(v) > 300 for k, v in descriptions.items()):
        raise ValueError("Supply one to six named object descriptions, at most 300 characters each")
    image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or not jpeg.startswith(b"\xff\xd8") or len(jpeg) > 16 * 1024 * 1024:
        raise ValueError("Supply a valid baseline JPEG of at most 16 MiB")
    height, width = image.shape[:2]
    if not (280 <= width <= 1568 and 280 <= height <= 1568):
        raise ValueError("Jev images require each side between 280 and 1568 pixels")
    asset_id = str(uuid.uuid4())
    questions = {}
    for index, (identity, description) in enumerate(descriptions.items()):
        questions[f"object_{index}_visible"] = {"type": "noul", "instructions": f"Is {description} visible in `tabletop_photo`? Return low probability when absent or unidentifiable."}
        questions[f"object_{index}_box"] = {"type": "box", "instructions": f"The {description} in `tabletop_photo`. Find only that named object."}
    payload = {"model": JEV_MODEL, "state": {"tabletop_photo": asset_id},
        "assets": {asset_id: {"type": "image", "part": "tabletop-photo"}}, "questions": questions}
    raw, provenance = await _call(payload, image=jpeg, client=client)
    suggestions = []
    try:
        if set(raw["answers"]) != set(questions):
            raise ValueError("Unexpected grounding answer names")
        for index, (identity, description) in enumerate(descriptions.items()):
            visible = Noul.model_validate(raw["answers"][f"object_{index}_visible"])
            box = Box.model_validate(raw["answers"][f"object_{index}_box"])
            accepted = visible.noul >= .8 and box.confidence >= .6
            suggestion = {"id": identity, "description": description, "presence_probability": visible.noul,
                "box": box.box.model_dump(), "confidence": box.confidence, "usable_suggestion": accepted,
                "requires_operator_confirmation": True}
            if crop_metadata:
                left, top, right, bottom = crop_metadata["pixel_bounds_ltrb"]
                pad_top, _, pad_left, _ = crop_metadata["padding_top_bottom_left_right"]
                if crop_metadata["uploaded_size"] != [width, height]:
                    raise ValueError("Crop metadata does not match the uploaded image")
                x1 = left + box.box.left * width - pad_left
                y1 = top + box.box.top * height - pad_top
                x2 = left + box.box.right * width - pad_left
                y2 = top + box.box.bottom * height - pad_top
                # A box extending into synthetic padding is unsuitable for seeding.
                if not (left <= x1 < x2 <= right and top <= y1 < y2 <= bottom):
                    suggestion["usable_suggestion"] = False
                suggestion["source_frame_bbox_xywh"] = [x1, y1, x2 - x1, y2 - y1]
            suggestions.append(suggestion)
    except (ValueError, KeyError, TypeError):
        raise JevError("Jev typed grounding response invalid; no object boxes established") from None
    return {"kind": "jev.box_grounding", "experimental": True, "advisory_only": True, "changes_tracker": False,
        "scope": {"frame_ref": frame_ref, "uploaded_jpeg_sha256": hashlib.sha256(jpeg).hexdigest(),
            "uploaded_size": [width, height], "crop": crop_metadata, "named_objects": descriptions,
            "coordinate_frame": "uploaded_image_fraction", "presence_threshold": .8, "confidence_threshold": .6,
            "threshold_note": "Local conservative suggestion thresholds; not vendor calibration or measured accuracy."},
        **provenance, "suggestions": suggestions, "raw_validated_response": raw}
