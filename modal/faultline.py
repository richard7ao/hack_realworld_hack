"""Optional bounded CPU execution of the SAME FAULTLINE engine; no fabricated rollouts.

Run from repository root after Modal login:
  .venv/bin/modal run modal/faultline.py --count 10
Local adapter validation (no cloud call): import this file then worker.local(...).
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
import uuid
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

image = (modal.Image.debian_slim(python_version='3.12')
         .pip_install('pydantic>=2.10,<3', 'httpx>=0.28,<1', 'python-dotenv>=1,<2')
         .add_local_python_source('backend'))
app = modal.App('faultline-pick', image=image)


@app.function(cpu=1, memory=512, max_containers=4, timeout=180, retries=0)
def worker(scenario_payload: dict, policy_id: str) -> dict:
    """Return complete episode artifacts so cloud container teardown loses no evidence."""
    from backend.models import Scenario
    from backend.runner import run_case
    from backend.storage import Storage

    if policy_id not in ('scripted_open_loop', 'scripted_reobserve'):
        raise ValueError('This cloud entrypoint accepts scripted policies only; frontier policies run locally with server keys')
    scenario = Scenario.model_validate(scenario_payload)
    with tempfile.TemporaryDirectory(prefix='faultline-') as folder:
        storage = Storage(folder)
        result, _ = asyncio.run(run_case(scenario, policy_id, storage))
        episode = f'episodes/{result.episode_id}'
        return {'result': result.model_dump(mode='json'),
                'scenario': storage.load(f'{episode}/scenario.json'),
                'trace_jsonl': storage.path(result.trace_ref).read_text(),
                'final_world': storage.load(f'{episode}/final_world.json'),
                'captured_disturbances': storage.load(f'{episode}/captured_disturbances.json')}


@app.local_entrypoint()
def main(count: int = 10, seed: int = 42017, data_dir: str = 'data'):
    from backend.generator import generate_cases
    from backend.models import CaseResult, GateConfig
    from backend.oracle import compare_results
    from backend.storage import Storage, canonical_hash

    if not 1 <= count <= 100:
        raise ValueError('count must be in [1,100]')
    storage = Storage(data_dir)
    cases = generate_cases(count, seed)
    policies = ('scripted_open_loop', 'scripted_reobserve')
    run_id = 'bench_modal_' + uuid.uuid4().hex[:12]
    relative = f'benchmarks/{run_id}.json'
    bench = {'id': run_id, 'created_at_ms': time.time() * 1000, 'status': 'RUNNING',
             'execution': 'modal_cpu', 'max_containers': 4,
             'baseline_policy': policies[0], 'candidate_policy': policies[1],
             'total_executions': count * 2, 'completed_executions': 0,
             'cases': [{'case_id': c.case_id, 'scenario_hash': canonical_hash(c), 'source': c.source} for c in cases],
             'results': [], 'errors': [], 'gate': None}
    for case in cases:
        storage.save_scenario(case)
    storage.save(relative, bench)
    jobs = [(c.model_dump(mode='json'), p) for c in cases for p in policies]
    baseline, candidate = [], []
    # Preserve input order so even transport failures retain the exact case/policy identity.
    for (payload, policy_id), output in zip(jobs, worker.starmap(jobs, order_outputs=True, return_exceptions=True)):
        if isinstance(output, Exception):
            bench['errors'].append({'case_id': payload['case_id'], 'policy_id': policy_id,
                                    'error_type': type(output).__name__})
            storage.save(relative, bench)
            continue
        result = CaseResult.model_validate(output['result'])
        if result.scenario_hash != canonical_hash(payload) or result.policy.policy_id != policy_id:
            raise ValueError('Worker result does not match submitted scenario/policy')
        episode = f'episodes/{result.episode_id}'
        storage.save(f'{episode}/scenario.json', output['scenario'])
        storage.save(f'{episode}/result.json', output['result'])
        storage.save(f'{episode}/final_world.json', output['final_world'])
        storage.save(f'{episode}/captured_disturbances.json', output['captured_disturbances'])
        storage.path(result.trace_ref).write_text(output['trace_jsonl'])
        (baseline if policy_id == policies[0] else candidate).append(result)
        bench['results'].append(output['result'])
        bench['completed_executions'] += 1
        storage.save(relative, bench)
        print(f'{payload["case_id"]} {policy_id}: {result.outcome} [{result.episode_id}]')
    bench['gate'] = compare_results(baseline, candidate, GateConfig())
    bench['status'] = 'ERROR' if bench['errors'] else 'DONE'
    storage.save(relative, bench)
    print(json.dumps({'benchmark': str(storage.path(relative)), 'gate': bench['gate'],
                      'completed_executions': bench['completed_executions'], 'errors': bench['errors']}, indent=2))
    if bench['errors']:
        raise RuntimeError('Some cloud episodes failed to execute; inspect persisted benchmark errors')
