"""Trust-boundary and evidence-integrity cases for deterministic simulation."""
import asyncio
import math

import pytest
from pydantic import ValidationError

from backend.engine import Environment, inside_destination
from backend.generator import sanity_case
from backend.models import Disturbance, GateConfig, ObjectEstimate, PolicyAction, Zone
from backend.oracle import compare_results
from backend.runner import run_case
from backend.storage import Storage, canonical_hash


@pytest.mark.parametrize("payload", [
    {"type": "MOVE_OBJECT", "object_id": "chocolate_A"},
    {"type": "MOVE_OBJECT", "position": [.2, .2, .02]},
    {"type": "OCCLUDE_OBJECT"},
    {"type": "ADD_OBSTACLE"},
    {"type": "MOVE_DESTINATION"},
])
def test_incomplete_disturbance_cannot_be_saved_as_a_real_event(payload):
    with pytest.raises(ValidationError):
        Disturbance(after_action_index=1, **payload)


def test_scenario_identity_is_immutable_on_disk(tmp_path):
    store = Storage(tmp_path)
    case = sanity_case()
    before_hash = store.save_scenario(case)
    case.disturbances[0].position = (.75, .6, .02)
    with pytest.raises(ValueError, match="Immutable"):
        store.save_scenario(case)
    assert canonical_hash(store.load(f"scenarios/{case.case_id}.json")) == before_hash


def test_storage_cannot_escape_evidence_root(tmp_path):
    store = Storage(tmp_path / "store")
    for path in ["../secret.txt", "scenarios/../../secret.txt", str(tmp_path / "outside.json")]:
        with pytest.raises(ValueError, match="Invalid storage path"):
            store.save(path, {"outside": True})
    assert not (tmp_path / "secret.txt").exists()
    assert not (tmp_path / "outside.json").exists()


def test_rejected_grasp_does_not_teleport_or_attach_target():
    case = sanity_case()
    env = Environment("ep_adversarial")
    env.reset(case)
    old_position = env.observation().detected_objects[0].position
    env.step(PolicyAction(type="MOVE_TO", position=old_position))
    moved_position = env.object(case.task.target_id).position
    result = env.step(PolicyAction(type="GRASP", target_id=case.task.target_id, position=old_position))
    assert result["info"].reason == "TARGET_DISPLACED"
    assert env.world.robot.holding_id is None
    assert env.object(case.task.target_id).position == moved_position
    assert env.object(case.task.target_id).authority == "camera"
    assert not any(event.kind == "object.released" for event in env.events)


def test_unverified_or_unknown_results_never_produce_a_passing_gate(tmp_path):
    case = sanity_case(family="none")
    result, _ = asyncio.run(run_case(case, "scripted_reobserve", Storage(tmp_path)))
    assert result.outcome == "PASS"
    for candidate in [result.model_copy(update={"verified": False}),
                      result.model_copy(update={"outcome": "UNKNOWN", "task_success": False})]:
        gate = compare_results([result], [candidate], GateConfig(minimum_cases=1, completion_threshold=0))
        assert gate["verdict"] == "INSUFFICIENT_EVIDENCE"
        assert gate["eligible_cases"] == 0 and gate["candidate_completion_rate"] is None


def test_duplicate_result_cannot_inflate_paired_case_count(tmp_path):
    result, _ = asyncio.run(run_case(sanity_case(family="none"), "scripted_reobserve", Storage(tmp_path)))
    gate = compare_results([result, result], [result, result], GateConfig(minimum_cases=2))
    assert gate["verdict"] == "INSUFFICIENT_EVIDENCE"
    assert gate["paired_cases"] == gate["eligible_cases"] == 1


def test_candidate_hard_violation_blocks_gate_even_without_matching_baseline(tmp_path):
    store = Storage(tmp_path)
    passing, _ = asyncio.run(run_case(sanity_case(family="none"), "scripted_open_loop", store))
    unsafe, _ = asyncio.run(run_case(sanity_case(seed=18, family="obstruction"), "scripted_open_loop", store))
    assert unsafe.constraint_violations and unsafe.outcome == "FAIL"
    gate = compare_results([passing], [passing, unsafe], GateConfig(minimum_cases=1))
    assert gate["verdict"] == "BLOCK"
    assert "FORBIDDEN_RULE_VIOLATION" in gate["reasons"]
    assert unsafe.case_id in gate["violations"]


def test_destination_verifies_rotated_full_footprint():
    target = ObjectEstimate(id="target", position=(.5, .5, .02), dimensions=(.2, .05, .04), yaw_rad=math.pi / 2)
    narrow_x = Zone(center=(.5, .5, .04), size=(.1, .25, .2))
    narrow_y = Zone(center=(.5, .5, .04), size=(.25, .1, .2))
    assert inside_destination(target, narrow_x)
    assert not inside_destination(target, narrow_y)
    target.position = (.54, .5, .02)
    assert not inside_destination(target, narrow_x)


def test_carried_rotated_object_sweeps_volume_beyond_gripper_point():
    case = sanity_case(family="none")
    case.initial_scene.objects[0].yaw_rad = math.pi / 2
    case.obstacles = [Zone(id="parcel_edge_obstacle", center=(.5, .42, .025), size=(.05, .02, .05))]
    env = Environment("ep_held_swept_volume")
    env.reset(case)
    p = env.object(case.task.target_id).position
    assert env.step(PolicyAction(type="MOVE_TO", position=p))["info"].status == "ok"
    assert env.step(PolicyAction(type="GRASP", target_id=case.task.target_id, position=p))["info"].status == "ok"
    result = env.step(PolicyAction(type="MOVE_TO", position=(.7, p[1], p[2])))
    assert result["info"].reason == "PATH_OBSTRUCTED"
    assert env.world.robot.position == p
    assert env.object(case.task.target_id).position == p


def test_completed_goal_after_simulation_deadline_is_timeout(tmp_path):
    case = sanity_case(family="none")
    # The unmodified scripted plan places at 4400 ms. It must not pass a
    # 4350 ms limit merely because release happened on its final step.
    case.limits.max_sim_seconds = 4.35
    result, env = asyncio.run(run_case(case, "scripted_open_loop", Storage(tmp_path)))
    assert any(event.kind == "object.released" for event in env.events)
    assert result.outcome == "TIMEOUT" and result.reason == "SIM_TIME_BUDGET"
    assert not result.task_success


def test_captured_occlusion_then_reappearance_replays_live_visibility_and_confidence(tmp_path):
    case = sanity_case(family="none")
    target_id = case.task.target_id
    initial_position = case.initial_scene.objects[0].position
    live = Environment("ep_occlusion_live_fixture")
    live.reset(case)
    live.step(PolicyAction(type="MOVE_TO", position=initial_position))

    hidden = case.initial_scene.model_copy(deep=True)
    hidden.seq = 1
    hidden.objects[0].visible, hidden.objects[0].confidence = False, 0
    live.sync_observation(hidden)
    reappeared = hidden.model_copy(deep=True)
    reappeared.seq = 2
    reappeared.objects[0].position = (.55, .5, .025)
    reappeared.objects[0].visible, reappeared.objects[0].confidence = True, .95
    live.sync_observation(reappeared)
    assert [d.type for d in live.live_disturbances] == ["OCCLUDE_OBJECT", "MOVE_OBJECT"]
    assert {d.after_action_index for d in live.live_disturbances} == {1}

    captured = case.model_copy(deep=True)
    captured.disturbances = [d.model_copy(deep=True) for d in live.live_disturbances]
    replay = Environment("ep_occlusion_replay_fixture")
    replay.reset(captured)
    replay.step(PolicyAction(type="MOVE_TO", position=initial_position))
    for env in [live, replay]:
        target = env.object(target_id)
        assert target.visible and target.confidence == .95
        assert target.position == (.55, .5, .025)
        env.step(PolicyAction(type="OBSERVE"))
    assert replay.observation().detected_objects == live.observation().detected_objects

    store = Storage(tmp_path)
    baseline, _ = asyncio.run(run_case(captured, "scripted_open_loop", store))
    candidate, _ = asyncio.run(run_case(captured, "scripted_reobserve", store))
    assert baseline.outcome == "FAIL" and baseline.reason == "TARGET_DISPLACED"
    assert candidate.outcome == "PASS"
    assert baseline.scenario_hash == candidate.scenario_hash == canonical_hash(captured)
