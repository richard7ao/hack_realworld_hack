"""Adapter contract tests. Native execution evidence is scripts/smoke_robosim.py.

Tests using synthetic RPC replies below test mapping/failure handling only; they
are not native physics executions and never write benchmark evidence.
"""
import asyncio
import json
from pathlib import Path
import pytest

from backend.engine import Environment
from backend.models import PolicyAction, Scenario
from backend.robosim import BACKEND, RoboSimEnvironment, environment_for, make_robosim_cases
from backend.storage import Storage, canonical_hash

ROOT = Path(__file__).resolve().parents[2]


def test_native_cases_opt_in_metric_immutable_manifest():
    a, b = make_robosim_cases()
    assert a.provenance['execution_backend'] == BACKEND
    assert a.initial_scene.coordinate_frame == 'workcell_m'
    assert a.initial_scene.workspace == (.595, 1.3)
    assert not a.disturbances
    assert b.disturbances[0].after_action_index == 1
    assert b.disturbances[0].position != b.initial_scene.objects[0].position
    assert canonical_hash(a) == canonical_hash(Scenario.model_validate(a.model_dump(mode='json')))
    assert isinstance(environment_for(a, 'test_native'), RoboSimEnvironment)
    a.provenance.pop('execution_backend')
    assert type(environment_for(a, 'test_plain')) is Environment
    for n in (0, 21):
        with pytest.raises(ValueError):
            make_robosim_cases(n)


def test_saved_physical_capture_hash_unaffected():
    p = ROOT / 'data/scenarios/CAPTURE-5e049d873f.json'
    if not p.exists():
        pytest.skip('Local physical evidence is not part of this checkout')
    case = Scenario.model_validate_json(p.read_text())
    assert canonical_hash(case) == '1f36b47976eaa916316d99a4a7ffbf0637962cba56fbd9bc5d0eeffeeb9be0ac'
    assert not isinstance(environment_for(case, 'test_capture'), RoboSimEnvironment)


def test_native_missing_runtime_has_no_cartesian_fallback(monkeypatch):
    import backend.robosim as module
    monkeypatch.setattr(module, 'status', lambda: {'available': False, 'reason': 'isolated runtime unavailable'})
    env = environment_for(make_robosim_cases(1)[0], 'test_missing')
    with pytest.raises(ValueError, match='isolated runtime unavailable'):
        env.reset(make_robosim_cases(1)[0])
    assert env.worker is None
    assert not any(e.kind == 'physics.initialized' for e in env.events)


def test_native_requires_metric_manifest_before_rpc():
    case = make_robosim_cases(1)[0]
    case.initial_scene.coordinate_frame = 'workcell_normalized'
    with pytest.raises(ValueError, match='metric scenario'):
        RoboSimEnvironment('test_frame').reset(case)


def test_native_rpc_mapping_holding_is_measured_not_command():
    """Synthetic sidecar reply deliberately reports no held object after close."""
    env = RoboSimEnvironment('test_mapping')
    Environment.reset(env, make_robosim_cases(1)[0])
    state = {'sim_time': .8, 'finite': True, 'objects': [{'id': 'native_cube', 'position': [.3, .5, .025],
             'quaternion': [.1, .2, .3, .9]}], 'robot': {
             'position': [.3, .5, .025], 'joint_angles': [0.] * 6, 'joint_limits': [[-3., 3.]] * 6,
             'link_positions': [[0., 0., 0.]], 'holding_id': None, 'mesh_poses': [],
             'native_contacts': [], 'native_physics': {'jaw_closed_fraction': .99}}}
    class SyntheticRPC:
        def request(self, request):
            assert request['op'] == 'grasp'
            return {'state': state, 'execution_ms': 800., 'details': {
                'ok': False, 'reason': 'NATIVE_GRASP_NOT_VERIFIED', 'actual_lift_m': 0., 'grasp_verified': False}}
    env.worker = SyntheticRPC()
    env.native_start_time = 0.
    env._ready = True
    env._native_state({'state': state})
    result = env.step(PolicyAction(type='GRASP', target_id='native_cube', position=(.3, .5, .025)))['info']
    assert result.status == 'rejected'
    assert result.reason == 'NATIVE_GRASP_NOT_VERIFIED'
    assert env.world.robot.holding_id is None
    assert env.world.objects[0].orientation_quaternion == (.1, .2, .3, .9)
    assert env.world.sim_elapsed_ms == 800.
    assert not any(e.kind == 'object.released' for e in env.events)
    # Native OBSERVE must not leak the simulator-only quaternion into the strict
    # ObjectEstimate schema; full orientation stays in actual world evidence.
    env.step(PolicyAction(type='OBSERVE'))
    assert env.observation().detected_objects[0].position == (.3, .5, .025)
    assert env.world.sim_elapsed_ms == 800.


def test_runner_closes_failed_native_initialization(monkeypatch, tmp_path):
    import backend.runner as runner
    closed = []
    class FailedNative(RoboSimEnvironment):
        def reset(self, scenario, seed=None):
            raise RuntimeError('actual worker unavailable')
        def close(self):
            closed.append(True)
    monkeypatch.setattr(runner, 'environment_for', lambda case, episode_id, emit: FailedNative(episode_id, emit))
    with pytest.raises(RuntimeError, match='worker unavailable'):
        asyncio.run(runner.run_case(make_robosim_cases(1)[0], 'scripted_open_loop', Storage(tmp_path)))
    assert closed == [True]
    assert not list((tmp_path / 'episodes').glob('*/result.json'))
