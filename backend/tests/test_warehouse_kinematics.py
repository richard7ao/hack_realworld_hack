"""Actual deterministic kinematics and warehouse execution, with no model mocks."""
import asyncio
import json
import math
from pathlib import Path

import numpy as np
import pytest

from backend.engine import Environment
from backend.generator import generate_cases, warehouse_cases
from backend.kinematics import (ArmConfig, KinematicsError, forward_kinematics,
    inverse_kinematics, joint_path, rpy_matrix)
from backend.models import PolicyAction, Scenario, Zone
from backend.policies import make_policy
from backend.runner import run_case
from backend.robots import robot_catalog, robot_config_for
from backend.storage import Storage, canonical_hash


@pytest.mark.parametrize("position,rpy", [
    ((1.15, 1.2, .1), (0., 0., 0.)),
    ((2.9, 1.05, .1), (.2, .1, .3)),
    ((1., 1., 1.4), (-.4, .6, -1.2)),
])
def test_six_joint_fk_ik_reaches_position_and_orientation(position, rpy):
    config = ArmConfig()
    solved = inverse_kinematics(position, config, orientation_rpy=rpy)
    fk = forward_kinematics(solved["joint_angles"], config)
    assert len(solved["joint_angles"]) == 6
    assert fk["position"] == pytest.approx(position, abs=1e-8)
    assert np.asarray(fk["rotation"]) == pytest.approx(rpy_matrix(rpy), abs=1e-8)
    assert solved["ik_residual_m"] < 1e-8
    assert len(fk["link_positions"]) == 7


def test_all_six_revolute_axes_change_forward_pose():
    config = ArmConfig()
    angles = [.2, -.8, 1.3, -.4, .3, -.2]
    original = forward_kinematics(angles, config)
    for index in range(6):
        moved = angles.copy()
        moved[index] += .1
        actual = forward_kinematics(moved, config)
        assert not (np.allclose(actual["position"], original["position"]) and
                    np.allclose(actual["rotation"], original["rotation"]))


def test_unreachable_and_joint_limit_rejections_leave_arm_unchanged():
    case = warehouse_cases(1)[0]
    env = Environment("ep_warehouse_reach_test")
    env.reset(case)
    before = env.world.robot.model_dump()
    rejected = env.step(PolicyAction(type="MOVE_TO", position=(.01, .01, 2.4), max_execution_ms=10000))
    assert rejected["info"].reason == "UNREACHABLE"
    assert env.world.robot.model_dump() == before

    case.provenance["robot_config"]["joint_limits"] = [(-.1, .1)] + [(-math.pi, math.pi)] * 5
    env.reset(case)
    before = env.world.robot.model_dump()
    rejected = env.step(PolicyAction(type="MOVE_TO", position=(1.15, 1.2, .1), max_execution_ms=10000))
    assert rejected["info"].reason == "JOINT_LIMIT"
    assert env.world.robot.model_dump() == before


def test_arm_link_collision_is_checked_between_clear_endpoints():
    config = ArmConfig()
    start = inverse_kinematics(config.home_position, config)["joint_angles"]
    goal = inverse_kinematics((1.15, 1.2, .1), config, start)["joint_angles"]
    mid = tuple((a + b) / 2 for a, b in zip(start, goal))
    elbow = forward_kinematics(mid, config)["link_positions"][2]
    obstacle = Zone(id="intermediate_elbow_collision", center=elbow, size=(.04, .04, .04))
    joint_path(start, start, config, [obstacle])
    joint_path(goal, goal, config, [obstacle])
    with pytest.raises(KinematicsError) as error:
        joint_path(start, goal, config, [obstacle])
    assert error.value.reason == "ARM_COLLISION"
    assert error.value.details["sample_index"] > 0
    assert error.value.details["obstacle_id"] == obstacle.id


def test_existing_captured_scenario_hash_and_default_generator_are_preserved():
    path = Path(__file__).resolve().parents[2] / "data/scenarios/CAPTURE-5e049d873f.json"
    if not path.exists():
        pytest.skip("Local physical-capture evidence is absent from this checkout")
    case = Scenario.model_validate_json(path.read_text())
    assert canonical_hash(case) == "1f36b47976eaa916316d99a4a7ffbf0637962cba56fbd9bc5d0eeffeeb9be0ac"
    assert "robot_config" not in case.provenance
    env = Environment("ep_legacy_hash_check")
    env.reset(case)
    assert env.world.robot.kinematics_kind == "cartesian"
    assert env.world.robot.joint_angles is None
    assert all("robot_config" not in c.provenance for c in generate_cases())


def test_warehouse_is_metric_seeded_declared_geometry_and_six_joint_state():
    a, b = warehouse_cases(4), warehouse_cases(4)
    assert [canonical_hash(case) for case in a] == [canonical_hash(case) for case in b]
    assert len({case.case_id for case in a}) == 4
    for case in a:
        assert case.source == "procedural" and case.initial_scene.sensor_mode == "PROCEDURAL"
        assert case.initial_scene.coordinate_frame == "workcell_m"
        assert case.initial_scene.workspace == (4., 3.)
        assert 10 <= len(case.initial_scene.objects) <= 20
        assert len(case.obstacles) >= 5
        env = Environment("ep_warehouse_contract")
        observation = env.reset(case)
        assert len(observation.robot.joint_angles) == len(observation.robot.joint_limits) == 6
        assert env.capabilities()["robot_config"]["kind"] == "six_dof_kinematic"
        assert "disturbances" not in observation.model_dump()


def test_real_route_collision_and_observed_geometry_planner_recovery(tmp_path):
    case = warehouse_cases(2)[1]
    store = Storage(tmp_path)
    baseline, a = asyncio.run(run_case(case, "scripted_open_loop", store))
    candidate, b = asyncio.run(run_case(case, "scripted_obstacle_aware", store))
    assert baseline.outcome == "FAIL" and baseline.reason == "ARM_COLLISION"
    assert baseline.constraint_violations == ["ARM_COLLISION"]
    assert candidate.outcome == "PASS" and candidate.constraint_violations == []
    assert baseline.scenario_hash == candidate.scenario_hash == canonical_hash(case)
    checked = [event for event in b.events if event.kind == "robot.kinematics_checked" and event.data["status"] == "ok"]
    assert checked and all(event.data["samples_checked"] > 0 for event in checked)
    assert all(event.data["ik_residual_m"] < 1e-7 for event in checked)
    assert any(len(event.data["joint_path_samples"]) > 2 for event in checked)
    assert any(event.kind == "object.released" for event in b.events)
    result = store.load(f"episodes/{candidate.episode_id}/result.json")
    assert result["model_calls"] == 0 and result["policy"]["policy_id"] == "scripted_obstacle_aware"
    final = store.load(f"episodes/{candidate.episode_id}/final_world.json")
    assert final["robot"]["joint_angles"] == list(b.world.robot.joint_angles)


def test_obstacle_aware_policy_does_not_receive_future_disturbances():
    cases = warehouse_cases(3)
    first = cases[0]
    changed = first.model_copy(deep=True)
    changed.disturbances = cases[2].disturbances
    actions = []
    for case in [first, changed]:
        env = Environment("ep_same_initial_observation")
        obs = env.reset(case)
        policy = make_policy("scripted_obstacle_aware")
        policy.reset(case.task, env.capabilities())
        actions.append(asyncio.run(policy.predict(obs)))
    assert actions[0] == actions[1]


def test_robot_registry_is_policy_independent_and_compact_geometry_executes(tmp_path):
    catalog = robot_catalog()
    assert {entry["id"] for entry in catalog} == {"cartesian", "industrial_6r", "compact_6r"}
    assert all(entry["implemented"] and entry["policy_independent"] for entry in catalog)
    assert robot_config_for("cartesian", (1., 1.), "workcell_normalized") is None
    with pytest.raises(ValueError, match="metric"):
        robot_config_for("industrial_6r", (1., 1.), "workcell_normalized")
    case = warehouse_cases(1)[0]
    main = robot_config_for("industrial_6r", (4., 3.), "workcell_m")
    compact = robot_config_for("compact_6r", (4., 3.), "workcell_m")
    assert compact["upper_arm"] < main["upper_arm"]
    case.case_id = "WAREHOUSE-compact-clean-test"
    case.provenance["robot_config"] = compact
    result, _ = asyncio.run(run_case(case, "scripted_obstacle_aware", Storage(tmp_path)))
    assert result.outcome == "PASS"
