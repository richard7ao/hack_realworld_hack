#!/usr/bin/env python3
"""Persist genuine scripted engine evidence. This does not claim physical camera QA."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.generator import sanity_case
from backend.models import GateConfig, Scenario
from backend.oracle import compare_results, evaluate
from backend.runner import run_case
from backend.storage import Storage, canonical_hash


def require(condition, message):
    if not condition:
        raise AssertionError(message)


async def execute(data_dir):
    storage = Storage(data_dir)
    smoke_id = 'smoke_' + uuid.uuid4().hex[:12]
    clean = sanity_case(seed=17, family='none')
    disturbed = sanity_case(seed=17)
    storage.save_scenario(clean)
    storage.save_scenario(disturbed)
    clean_result, clean_env = await run_case(clean, 'scripted_open_loop', storage)
    baseline, baseline_env = await run_case(disturbed, 'scripted_open_loop', storage)
    candidate, candidate_env = await run_case(disturbed, 'scripted_reobserve', storage)
    require(clean_result.outcome == 'PASS', 'Clean pick failed')
    require(baseline.outcome == 'FAIL' and baseline.reason == 'TARGET_DISPLACED', 'Stale target was not rejected')
    require(candidate.outcome == 'PASS' and candidate.recovery_attempts >= 1, 'Fresh observation did not recover')
    reloaded = Scenario.model_validate(storage.load(f'scenarios/{disturbed.case_id}.json'))
    rerun, rerun_env = await run_case(reloaded, 'scripted_reobserve', storage)
    require(rerun.outcome == 'PASS', 'Persisted scenario rerun failed')
    results = [clean_result, baseline, candidate, rerun]
    envs = [clean_env, baseline_env, candidate_env, rerun_env]
    require(len({r.episode_id for r in results}) == 4, 'Fresh executions must have unique episode IDs')
    require(baseline.scenario_hash == candidate.scenario_hash == rerun.scenario_hash == canonical_hash(reloaded),
            'Policy comparison was not on an identical saved case')
    require(candidate.actions == rerun.actions, 'Scripted rerun action count changed')
    for result, env in zip(results, envs):
        require(evaluate(env)[0] == result.outcome, 'Independent oracle disagrees with persisted result')
        require(storage.load(f'episodes/{result.episode_id}/result.json')['outcome'] == result.outcome,
                'Result persistence mismatch')
        events = [json.loads(line) for line in storage.path(result.trace_ref).read_text().splitlines()]
        require([e['seq'] for e in events] == list(range(1, len(events) + 1)), 'Trace sequence is not contiguous')
        require(events[-1]['kind'] == 'benchmark.case_finished', 'Trace has no completed evaluation')
        require(events[-1]['data']['outcome'] == result.outcome, 'Trace result mismatch')
        if result.outcome == 'PASS':
            require(any(e['kind'] == 'object.released' for e in events), 'Pass has no release evidence')
    gate = compare_results([baseline], [candidate], GateConfig(minimum_cases=1, completion_threshold=1))
    reverse = compare_results([candidate], [baseline], GateConfig(minimum_cases=1, completion_threshold=0))
    require(gate['verdict'] == 'PASS' and disturbed.case_id in gate['fixes'], 'Fix comparison failed')
    require(reverse['verdict'] == 'BLOCK' and disturbed.case_id in reverse['regressions'], 'Regression did not block')
    report = {'id': smoke_id, 'status': 'PASS', 'created_at_ms': time.time() * 1000,
              'scope': 'procedural scripted 2.5D simulation; camera and remote APIs not exercised',
              'checks': ['clean_pick', 'stale_target_rejected', 'fresh_observation_recovers',
                         'immutable_scenario_reload', 'fresh_episode', 'durable_contiguous_traces',
                         'independent_oracle', 'fix_gate', 'regression_gate'],
              'results': [r.model_dump(mode='json') for r in results], 'gate': gate, 'reverse_gate': reverse}
    relative = f'smoke/{smoke_id}.json'
    storage.save(relative, report)
    storage.save('smoke-latest.json', {'report_ref': relative, 'status': 'PASS',
                                       'episodes': [r.episode_id for r in results]})
    print(json.dumps({'status': 'PASS', 'evidence': str(storage.path(relative)),
                      'outcomes': [r.outcome for r in results], 'gate': gate['verdict'],
                      'regression_gate': reverse['verdict'], 'scope': report['scope']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path('data'))
    asyncio.run(execute(parser.parse_args().data_dir))
