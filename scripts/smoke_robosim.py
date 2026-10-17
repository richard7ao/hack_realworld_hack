#!/usr/bin/env python3
"""Execute actual isolated RoboSimStudio CPU physics and retain honest evidence.

No model/API calls. Outcomes are independently evaluated from native object poses,
measured bilateral contacts, actual dynamic lift, and open/settled release.
"""
from __future__ import annotations
import argparse
import asyncio
import json
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.models import GateConfig
from backend.oracle import compare_results
from backend.robosim import BACKEND, SOURCE_COMMIT, NativeWorker, make_robosim_cases, status
from backend.runner import run_case
from backend.storage import Storage, canonical_hash


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--count', type=int, default=2, help='1..20 new native cases, each executed freshly by both scripted policies')
    parser.add_argument('--seed', type=int, default=42017)
    args = parser.parse_args()
    cases = make_robosim_cases(args.count, args.seed)
    store = Storage(ROOT / 'data')
    run_id = 'bench_robosim_' + uuid.uuid4().hex[:12]
    report = {'id': run_id, 'status': 'RUNNING', 'created_at_ms': time.time() * 1000,
        'execution_backend': BACKEND, 'source_commit': SOURCE_COMMIT,
        'baseline_policy': 'scripted_open_loop', 'candidate_policy': 'scripted_reobserve',
        'total_executions': len(cases) * 2, 'completed_executions': 0,
        'cases': [{'case_id': c.case_id, 'scenario_hash': canonical_hash(c), 'source': c.source} for c in cases],
        'results': [], 'errors': [], 'gate': None,
        'scope': 'Native simulated contact physics on CPU; procedural source, not physical camera capture or hardware validation.'}
    proof = {'native_physics_verified': False, 'source_commit': SOURCE_COMMIT,
             'benchmark_ref': f'benchmarks/{run_id}.json', 'runtime': status(), 'errors': []}
    try:
        # Direct native free-body falling test, independent of policy commands.
        falling = cases[0].model_copy(deep=True)
        falling.case_id = f'ROBOSIM-fall-proof-{uuid.uuid4().hex[:8]}'
        falling.initial_scene.objects[0].position = (.2975, .5, .20)
        falling.disturbances = []
        store.save_scenario(falling)
        worker = NativeWorker()
        try:
            measured = worker.request({'op': 'init', 'scenario': falling.model_dump(mode='json')})['state']
            final = measured['objects'][0]
            proof['falling_cube'] = {'scenario_ref': f'scenarios/{falling.case_id}.json',
                'scenario_hash': canonical_hash(falling), 'initial_measured_position': measured['robot']['native_physics']['initial_objects'][0]['position'],
                'final_measured_position': final['position'], 'final_quaternion_xyzw': final['quaternion'],
                'actual_sim_time_seconds': measured['sim_time'], 'finite': measured['finite'],
                'native_contacts': measured['robot']['native_contacts'], 'mesh_pose_count': len(measured['robot']['mesh_poses'])}
        finally:
            worker.close()
        baseline, candidate = [], []
        grasp_measurements = []
        for case in cases:
            store.save_scenario(case)
            for policy, bucket in [('scripted_open_loop', baseline), ('scripted_reobserve', candidate)]:
                result, env = await run_case(case, policy, store)
                bucket.append(result)
                report['results'].append(result.model_dump(mode='json'))
                report['completed_executions'] += 1
                for event in env.events:
                    if event.kind == 'physics.action_executed' and event.data['action_type'] == 'GRASP':
                        grasp_measurements.append({'episode_id': result.episode_id, **event.data})
                print(json.dumps({'episode_id': result.episode_id, 'case_id': case.case_id, 'policy': policy,
                                  'outcome': result.outcome, 'reason': result.reason}), flush=True)
                store.save(f'benchmarks/{run_id}.json', report)
        report['gate'] = compare_results(baseline, candidate, GateConfig(minimum_cases=len(cases)))
        report['status'] = 'DONE'
        proof['grasp_measurements'] = grasp_measurements
        fall = proof['falling_cube']
        proof['native_physics_verified'] = (fall['finite'] and fall['mesh_pose_count'] == 18 and
            fall['initial_measured_position'][2] - fall['final_measured_position'][2] > .10 and
            bool(fall['native_contacts']) and any(g.get('grasp_verified') and g['actual_lift_m'] >= .025 for g in grasp_measurements))
        proof['results'] = report['results']
        proof['gate'] = report['gate']
    except Exception as exc:
        report['status'] = 'ERROR'
        report['errors'].append(f'{type(exc).__name__}: {exc}')
        proof['errors'] = report['errors']
        raise
    finally:
        proof['completed_at_ms'] = time.time() * 1000
        store.save(f'benchmarks/{run_id}.json', report)
        store.save(f'robosim-smoke-{run_id}.json', proof)
        store.save('robosim-smoke-latest.json', proof)
        print(json.dumps({'benchmark_ref': f'benchmarks/{run_id}.json',
                          'native_physics_verified': proof['native_physics_verified'], 'status': report['status']}), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
