import asyncio
import json
import pytest
from backend.engine import Environment
from backend.generator import sanity_case, generate_cases
from backend.models import Disturbance, PolicyAction, GateConfig, Scenario, Zone
from backend.oracle import evaluate, compare_results
from backend.runner import run_case
from backend.storage import Storage, canonical_hash


def run(case, policy, tmp_path):
    return asyncio.run(run_case(case, policy, Storage(tmp_path)))


def test_clean_pick_is_independently_verified(tmp_path):
    result, env = run(sanity_case(family="none"), "scripted_open_loop", tmp_path)
    assert result.outcome == "PASS"
    assert env.world.robot.holding_id is None
    assert any(e.kind == "object.released" for e in env.events)


def test_same_displacement_breaks_stale_plan_and_fresh_policy_recovers(tmp_path):
    case = sanity_case()
    a, _ = run(case, "scripted_open_loop", tmp_path)
    b, _ = run(case, "scripted_reobserve", tmp_path)
    assert a.outcome == "FAIL" and a.reason == "TARGET_DISPLACED"
    assert b.outcome == "PASS" and b.recovery_attempts >= 1
    assert a.episode_id != b.episode_id and a.scenario_hash == b.scenario_hash
    assert compare_results([a], [b], GateConfig(minimum_cases=1))["fixes"] == [case.case_id]


def test_policy_cannot_assert_success():
    env = Environment("ep_test")
    env.reset(sanity_case(family="none"))
    env.step(PolicyAction(type="DONE", reason="I succeeded"))
    assert evaluate(env)[0] == "FAIL"


def test_hidden_disturbance_not_in_policy_observation():
    env = Environment("ep_test")
    obs = env.reset(sanity_case())
    initial = obs.detected_objects[0].position
    env.step(PolicyAction(type="MOVE_TO", position=initial))
    assert env.world.objects[0].position != initial
    assert env.observation().detected_objects[0].position == initial
    assert "disturbances" not in env.observation().model_dump()
    env.step(PolicyAction(type="OBSERVE"))
    assert env.observation().detected_objects[0].position == env.world.objects[0].position


def test_held_object_cannot_snap_back_to_camera():
    case = sanity_case(family="none")
    env = Environment("ep_test")
    env.reset(case)
    p = env.world.objects[0].position
    env.step(PolicyAction(type="MOVE_TO", position=p))
    env.step(PolicyAction(type="GRASP", target_id="chocolate_A", position=p))
    scene = case.initial_scene.model_copy(deep=True)
    scene.seq = 1
    scene.objects[0].position = (0.1, 0.8, 0.025)
    env.sync_observation(scene)
    assert env.world.objects[0].position == p
    assert env.world.objects[0].authority == "simulator"


def test_occlusion_is_not_secretly_visible(tmp_path):
    result, _ = run(sanity_case(family="occlusion"), "scripted_reobserve", tmp_path)
    assert result.outcome == "ESCALATED"
    assert not result.task_success


def test_wrong_object_attempt_is_hard_violation():
    env = Environment("ep_test")
    env.reset(sanity_case(family="none"))
    env.step(PolicyAction(type="GRASP", target_id="carton_B", position=(0.55, 0.3, 0.04)))
    assert evaluate(env)[:2] == ("FAIL", "WRONG_OBJECT")


def test_swept_path_and_reach():
    case = sanity_case(family="none")
    case.obstacles = [Zone(id="wall", center=(0.4, 0.4, 0.2), size=(0.05, 0.8, 0.4))]
    env = Environment("ep_test")
    env.reset(case)
    result = env.step(PolicyAction(type="MOVE_TO", position=(0.8, 0.8, 0.1)))
    assert result["info"].reason == "PATH_OBSTRUCTED"
    assert env.world.robot.position != (0.8, 0.8, 0.1)
    assert env.step(PolicyAction(type="MOVE_TO", position=(2, 0, 0)))["info"].reason == "OUT_OF_REACH"


def test_persistence_hash_and_fresh_rerun(tmp_path):
    store = Storage(tmp_path)
    case = sanity_case()
    store.save_scenario(case)
    loaded = Scenario.model_validate(store.load(f"scenarios/{case.case_id}.json"))
    a, _ = run(loaded, "scripted_reobserve", tmp_path)
    b, _ = run(loaded, "scripted_reobserve", tmp_path)
    assert a.outcome == b.outcome == "PASS"
    assert a.actions == b.actions
    assert a.scenario_hash == canonical_hash(case)
    lines = store.path(a.trace_ref).read_text().splitlines()
    events = [json.loads(line) for line in lines]
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert events[-1]["kind"] == "benchmark.case_finished"


def test_gate_blocks_individual_regression(tmp_path):
    case = sanity_case()
    passing, _ = run(case, "scripted_reobserve", tmp_path)
    failing, _ = run(case, "scripted_open_loop", tmp_path)
    gate = compare_results([passing], [failing], GateConfig(minimum_cases=1, completion_threshold=0))
    assert gate["verdict"] == "BLOCK" and gate["regressions"] == [case.case_id]
    assert compare_results([failing], [passing], GateConfig())["verdict"] == "INSUFFICIENT_EVIDENCE"


def test_hash_mismatch_is_not_a_pair(tmp_path):
    a, _ = run(sanity_case(17), "scripted_reobserve", tmp_path)
    b, _ = run(sanity_case(18), "scripted_reobserve", tmp_path)
    assert compare_results([a], [b], GateConfig(minimum_cases=1))["eligible_cases"] == 0


def test_generated_scenarios_have_no_outcomes():
    cases = generate_cases()
    assert len(cases) == len({c.case_id for c in cases}) == 10
    assert all("outcome" not in c.model_dump() for c in cases)
