#!/usr/bin/env python3
"""Execute paired policies on real fresh environments; persist every result/trace."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.generator import generate_cases, warehouse_cases
from backend.models import GateConfig, Scenario
from backend.oracle import compare_results
from backend.policies import make_policy
from backend.runner import run_case
from backend.storage import Storage, canonical_hash


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--count', type=int, default=10, help='Legacy generated cases, default 10; use 0 for saved/warehouse-only runs')
    parser.add_argument('--warehouse-count', type=int, default=0, help='Additional metric six-joint warehouse cases, default 0')
    parser.add_argument('--seed', type=int, default=42017)
    parser.add_argument('--scenario', type=Path, action='append', default=[], help='Saved scenario JSON; repeatable')
    parser.add_argument('--baseline', default='scripted_open_loop')
    parser.add_argument('--candidate', default='scripted_reobserve')
    parser.add_argument('--data-dir', type=Path, default=Path('data'))
    parser.add_argument('--minimum-cases', type=int, default=3)
    parser.add_argument('--completion-threshold', type=float, default=0.8)
    parser.add_argument('--fail-on-gate', action='store_true', help='Exit 2 unless gate is PASS (CI mode)')
    args = parser.parse_args()
    if not 0 <= args.count <= 100:
        parser.error('--count must be in [0,100]')
    if not 0 <= args.warehouse_count <= 100:
        parser.error('--warehouse-count must be in [0,100]')
    if not 1 <= args.count + args.warehouse_count + len(args.scenario) <= 100:
        parser.error('Choose 1 to 100 total scenarios')
    return args


async def execute(args):
    config = GateConfig(minimum_cases=args.minimum_cases, completion_threshold=args.completion_threshold)
    # Fail before creating a misleading benchmark when a provider key/model is unavailable.
    make_policy(args.baseline)
    make_policy(args.candidate)
    cases = [Scenario.model_validate_json(p.read_text()) for p in args.scenario]
    cases += generate_cases(args.count, args.seed)
    warehouse_count = getattr(args, 'warehouse_count', 0)
    if warehouse_count:
        cases += warehouse_cases(warehouse_count, args.seed)
    if len({case.case_id for case in cases}) != len(cases):
        raise ValueError('Scenario IDs must be distinct')
    storage = Storage(args.data_dir)
    run_id = 'bench_cli_' + uuid.uuid4().hex[:12]
    relative = f'benchmarks/{run_id}.json'
    bench = {'id': run_id, 'status': 'RUNNING', 'created_at_ms': time.time() * 1000,
             'baseline_policy': args.baseline, 'candidate_policy': args.candidate,
             'total_executions': len(cases) * 2, 'completed_executions': 0,
             'results': [], 'errors': [], 'gate': None,
             'cases': [{'case_id': c.case_id, 'source': c.source, 'scenario_hash': canonical_hash(c)} for c in cases],
             'definition_counts': {'legacy_generated': args.count, 'warehouse_generated': warehouse_count,
                                   'saved_manifests': len(args.scenario)},
             'execution': 'local_headless', 'scope': 'simulated symbolic manipulation; robot configuration fixed by each scenario'}
    storage.save(relative, bench)
    baseline, candidate = [], []
    for case in cases:
        storage.save_scenario(case)
        for policy_id, bucket in ((args.baseline, baseline), (args.candidate, candidate)):
            try:
                result, _ = await run_case(case, policy_id, storage)
            except Exception as exc:
                bench['errors'].append({'case_id': case.case_id, 'policy_id': policy_id,
                                        'error_type': type(exc).__name__})
                storage.save(relative, bench)
                print(f'{case.case_id} {policy_id}: execution error {type(exc).__name__}', flush=True)
                continue
            bucket.append(result)
            bench['results'].append(result.model_dump(mode='json'))
            bench['completed_executions'] += 1
            storage.save(relative, bench)
            print(f'{case.case_id} {policy_id}: {result.outcome} / {result.reason} [{result.episode_id}]', flush=True)
    bench['gate'] = compare_results(baseline, candidate, config)
    bench['status'] = 'ERROR' if bench['errors'] else 'DONE'
    storage.save(relative, bench)
    storage.save('benchmark-latest.json', {'benchmark_ref': relative, 'id': run_id, 'gate': bench['gate']})
    if warehouse_count:
        storage.save('warehouse-benchmark-latest.json', {'benchmark_ref': relative, 'id': run_id, 'gate': bench['gate']})
    print(json.dumps({'benchmark': str(storage.path(relative)),
                      'completed_executions': bench['completed_executions'], 'gate': bench['gate']}, indent=2))
    return 1 if bench['errors'] else (2 if args.fail_on_gate and bench['gate']['verdict'] != 'PASS' else 0)


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(execute(arguments())))
    except (ValueError, OSError) as exc:
        raise SystemExit(str(exc)) from None
