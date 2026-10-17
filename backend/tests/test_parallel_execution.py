import asyncio
import pytest
from backend.benchmark_dispatch import dispatch_cases
from backend.generator import generate_cases
from backend.storage import Storage, canonical_hash


def test_actual_paired_executions_overlap_and_keep_artifacts(tmp_path):
    cases = generate_cases(3, 991)
    hashes = [canonical_hash(c) for c in cases]
    events = []
    result = asyncio.run(dispatch_cases(cases, 'scripted_open_loop', 'scripted_reobserve',
                                      Storage(tmp_path), concurrency=3, on_progress=events.append))
    assert result['peak_concurrency'] == 3
    assert len(result['baseline']) == len(result['candidate']) == 3
    assert not result['errors']
    assert len({r.episode_id for r in result['baseline'] + result['candidate']}) == 6
    assert [canonical_hash(c) for c in cases] == hashes
    for case in cases:
        a = next(r for r in result['baseline'] if r.case_id == case.case_id)
        b = next(r for r in result['candidate'] if r.case_id == case.case_id)
        assert a.scenario_hash == b.scenario_hash == canonical_hash(case)
        assert (tmp_path / a.trace_ref).is_file()
    assert sum(e['type'] == 'completed' for e in events) == 6


def test_failure_is_explicit_and_does_not_cancel_other_pairs(tmp_path, monkeypatch):
    import backend.benchmark_dispatch as module
    original = module.run_case
    async def sometimes_fails(scenario, policy, storage):
        if policy == 'scripted_open_loop':
            raise RuntimeError('do not expose tokens in errors')
        return await original(scenario, policy, storage)
    monkeypatch.setattr(module, 'run_case', sometimes_fails)
    result = asyncio.run(dispatch_cases(generate_cases(2, 992), 'scripted_open_loop',
                                        'scripted_reobserve', Storage(tmp_path)))
    assert len(result['errors']) == 2
    assert len(result['candidate']) == 2
    assert not result['baseline']
    assert all(e['error_type'] == 'RuntimeError' for e in result['errors'])
    assert 'tokens' not in str(result)


def test_rejects_duplicate_pairs_and_invalid_concurrency(tmp_path):
    case = generate_cases(1, 993)[0]
    with pytest.raises(ValueError, match='Duplicate'):
        asyncio.run(dispatch_cases([case, case], 'scripted_open_loop', 'scripted_reobserve', Storage(tmp_path)))
    with pytest.raises(ValueError, match='concurrency'):
        asyncio.run(dispatch_cases([case], 'scripted_open_loop', 'scripted_reobserve', Storage(tmp_path), concurrency=0))


def test_modal_rejects_camera_inputs_before_upload(tmp_path):
    from backend.benchmark_dispatch import validate_dispatch
    case = generate_cases(1, 994)[0]
    case.initial_scene.sensor_mode = 'RGB'
    with pytest.raises(ValueError, match='Camera'):
        validate_dispatch([case], 'scripted_open_loop', 'scripted_reobserve', 'modal_cpu', 2)


def test_modal_rejects_native_execution_before_upload():
    from backend.benchmark_dispatch import validate_dispatch
    case = generate_cases(1, 995)[0]
    case.provenance['execution_backend'] = 'robosimstudio_cpu'
    with pytest.raises(ValueError, match='Native'):
        validate_dispatch([case], 'scripted_open_loop', 'scripted_reobserve', 'modal_cpu', 2)


@pytest.fixture
def cloud_output(tmp_path):
    import json
    from backend.runner import run_case
    scenario = generate_cases(1, 998)[0]
    storage = Storage(tmp_path / 'worker')
    result, _ = asyncio.run(run_case(scenario, 'scripted_reobserve', storage))
    episode = f'episodes/{result.episode_id}'
    output = {name: storage.load(f'{episode}/{name}.json')
              for name in ('scenario', 'result', 'final_world', 'captured_disturbances')}
    output['trace_jsonl'] = storage.path(result.trace_ref).read_text()
    output['execution'] = {'backend': 'modal_cpu', 'container_id': 'ta-test', 'input_id': 'in-test',
                           'function_call_id': 'fc-test', 'started_at_ms': 1., 'finished_at_ms': 2.}
    return scenario, output


def test_accepts_complete_consistent_cloud_evidence(cloud_output):
    from backend.benchmark_dispatch import validate_cloud_output
    scenario, output = cloud_output
    result, _ = validate_cloud_output(output, scenario, 'scripted_reobserve')
    assert result.verified


@pytest.mark.parametrize('mutation', ['provenance', 'episode', 'sequence', 'terminal', 'world', 'path'])
def test_cloud_rejects_inconsistent_evidence_before_any_write(cloud_output, tmp_path, monkeypatch, mutation):
    import json
    import sys
    from types import SimpleNamespace
    from backend.benchmark_dispatch import modal_case
    scenario, output = cloud_output
    if mutation == 'provenance':
        output['execution'].pop('container_id')
    elif mutation == 'world':
        output['final_world']['step'] += 1
    elif mutation == 'path':
        output['result']['trace_ref'] = '../escape.jsonl'
    else:
        events = [json.loads(line) for line in output['trace_jsonl'].splitlines()]
        if mutation == 'episode':
            events[1]['episode_id'] = 'ep_wrong'
        elif mutation == 'sequence':
            events[1]['seq'] = 1
        else:
            events[-1]['data']['outcome'] = 'UNKNOWN'
        output['trace_jsonl'] = '\n'.join(json.dumps(e) for e in events)
    async def remote(*args):
        return output
    worker = SimpleNamespace(remote=SimpleNamespace(aio=remote))
    monkeypatch.setitem(sys.modules, 'modal', SimpleNamespace(Function=SimpleNamespace(from_name=lambda *args: worker)))
    local = Storage(tmp_path / 'local')
    with pytest.raises(ValueError):
        asyncio.run(modal_case(scenario, 'scripted_reobserve', local))
    assert not list(local.path('episodes').iterdir())
