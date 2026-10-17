import asyncio
from backend.production import ProductionLine
from backend.storage import Storage, canonical_hash


def test_four_actual_kinematic_stages_carry_world_and_verify(tmp_path):
    storage = Storage(tmp_path)
    events = []
    line = ProductionLine(storage,publish=events.append)
    job = line.create('session','scripted_obstacle_aware',0)
    final = asyncio.run(line.run(job['job_id']))
    assert final['status'] == 'SUCCEEDED'
    assert final['completed_stages'] == 4
    assert 0 < final['total_actions'] <= 200
    assert final['total_model_calls'] == 0
    assert len({s['result']['episode_id'] for s in final['stages']}) == 4
    for index,stage in enumerate(final['stages']):
        result = stage['result']
        case = storage.load(f"scenarios/{stage['case_id']}.json")
        assert canonical_hash(case) == result['scenario_hash'] == stage['scenario_hash']
        assert result['outcome'] == 'PASS' and result['verified']
        world = storage.load(f"episodes/{result['episode_id']}/final_world.json")
        assert world['robot']['kinematics_kind'] == 'six_dof_kinematic'
        if index:
            prior = final['stages'][index-1]['result']
            prior_world = storage.load(f"episodes/{prior['episode_id']}/final_world.json")
            assert {o['id']:o['position'] for o in case['initial_scene']['objects']} == {o['id']:o['position'] for o in prior_world['objects']}
    assert any(e.kind == 'disturbance.detected' for e in events)


def test_changes_queue_for_next_stage_and_do_not_rewrite_completed_hash(tmp_path):
    storage = Storage(tmp_path)
    line = None
    def publish(event):
        if event.kind == 'production.stage_started' and event.data['stage']['index'] == 0:
            line.change(event.data['job_id'],'reroute_next')
    line = ProductionLine(storage,publish=publish)
    job = line.create('session','scripted_obstacle_aware',0)
    final = asyncio.run(line.run(job['job_id']))
    assert final['status'] == 'SUCCEEDED'
    assert final['changes'][0]['stage_index'] == 1
    assert final['changes'][0]['status'] == 'APPLIED_BEFORE_STAGE_FREEZE'
    first = storage.load(f"scenarios/{final['stages'][0]['case_id']}.json")
    second = storage.load(f"scenarios/{final['stages'][1]['case_id']}.json")
    assert first['destination']['center'][0] == 2.9
    assert second['destination']['center'][0] == 2.55
    assert canonical_hash(first) == final['stages'][0]['result']['scenario_hash']


def test_actual_failure_preserves_prior_success_and_leaves_future_pending(tmp_path):
    line = ProductionLine(Storage(tmp_path))
    job = line.create('session','scripted_open_loop',0)
    final = asyncio.run(line.run(job['job_id']))
    assert final['status'] == 'FAILED'
    completed = [s for s in final['stages'] if s['result']]
    assert completed
    assert final['completed_stages'] == 1
    assert final['stages'][0]['result']['outcome'] == 'PASS'
    assert completed[-1]['result']['outcome'] != 'PASS'
    assert any(s['status'] == 'WAITING' for s in final['stages'])


def test_stop_checkpoint_does_not_forge_success(tmp_path):
    async def stop(env):
        return 'POLICY_ERROR:OPERATOR_STOPPED'
    line = ProductionLine(Storage(tmp_path),checkpoint=stop)
    job = line.create('session','scripted_obstacle_aware',0)
    final = asyncio.run(line.run(job['job_id']))
    assert final['status'] == 'FAILED'
    assert final['completed_stages'] == 0
    assert final['stages'][0]['result']['reason'] == 'POLICY_ERROR:OPERATOR_STOPPED'
