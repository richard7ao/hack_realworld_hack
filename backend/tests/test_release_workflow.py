"""Product release checks preserve real parallel execution and gate provenance."""
import asyncio
import importlib
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from backend.generator import generate_cases
from backend.models import GateConfig
from backend.runtime import Runtime
from backend.storage import Storage, canonical_hash


def test_parallel_release_workflow_persists_jobs_and_real_pair_gate(tmp_path):
    runtime = Runtime(Storage(tmp_path))
    session = runtime.create_session()
    cases = generate_cases(3, 88017)
    async def run():
        bench = runtime.benchmark(session, cases, 'scripted_open_loop', 'scripted_reobserve',
                                  GateConfig(minimum_cases=3), concurrency=3)
        await asyncio.gather(*list(runtime.tasks))
        return bench
    bench = asyncio.run(run())
    assert bench['status'] == 'DONE' and not bench['errors']
    assert bench['completed_executions'] == 6
    assert bench['active_executions'] == 0 and bench['peak_concurrency'] == 3
    assert len({j['episode_id'] for j in bench['jobs']}) == 6
    assert all(j['status'] == 'DONE' for j in bench['jobs'])
    assert bench['gate']['paired_cases'] == 3
    for case in cases:
        results = [r for r in bench['results'] if r['case_id'] == case.case_id]
        assert len(results) == 2 and all(r['scenario_hash'] == canonical_hash(case) for r in results)
    assert runtime.storage.load(f"benchmarks/{bench['id']}.json") == bench


def test_environment_catalog_and_execution_preflight(tmp_path, monkeypatch):
    module = importlib.import_module('backend.app')
    monkeypatch.setattr(module, 'runtime', Runtime(Storage(tmp_path)))
    with TestClient(module.app) as client:
        catalog = client.get('/api/environments').json()
        assert {e['id'] for e in catalog['environments']} == {'camera', 'warehouse', 'physics'}
        assert all(e['purpose'] and e['fidelity'] and e['case_families'] for e in catalog['environments'])
        assert catalog['execution_backends'][0]['supported_environments'] == ['camera', 'warehouse', 'physics']
        session = client.post('/api/camera/session').json()
        body = {'session_id': session['session_id'], 'generated_count': 1, 'concurrency': 5}
        headers = {'Authorization': 'Bearer ' + session['token']}
        assert client.post('/api/benchmarks/run', json=body, headers=headers).status_code == 422
        body.update(concurrency=2, baseline='scripted_open_loop', candidate='scripted_open_loop')
        assert client.post('/api/benchmarks/run', json=body, headers=headers).status_code == 422


def test_atomic_save_supports_concurrent_same_case_writers(tmp_path):
    storage = Storage(tmp_path)
    case = generate_cases(1, 88018)[0]
    with ThreadPoolExecutor(max_workers=4) as pool:
        hashes = list(pool.map(lambda _: storage.save_scenario(case), range(40)))
    assert len(set(hashes)) == 1
    assert canonical_hash(storage.load(f'scenarios/{case.case_id}.json')) == hashes[0]
    assert not list(tmp_path.rglob('*.tmp'))
