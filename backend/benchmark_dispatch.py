"""Bounded paired executions with measured timings and verified cloud artifacts."""
from __future__ import annotations

import asyncio
import json
import math
import re
import time
from .models import CaseResult, Scenario
from .runner import run_case
from .storage import canonical_hash


async def modal_case(scenario, policy_id, storage):
    import modal
    worker = modal.Function.from_name('faultline-pick', 'worker')
    output = await worker.remote.aio(scenario.model_dump(mode='json'), policy_id)
    result, provenance = validate_cloud_output(output, scenario, policy_id)
    episode = f'episodes/{result.episode_id}'
    for name in ('scenario', 'result', 'final_world', 'captured_disturbances'):
        storage.save(f'{episode}/{name}.json', output[name])
    storage.path(result.trace_ref).write_text(output['trace_jsonl'])
    return result, provenance


def validate_cloud_output(output, scenario, policy_id):
    """Validate every remote artifact before any local write."""
    result = CaseResult.model_validate(output['result'])
    if (result.scenario_hash != canonical_hash(scenario)
            or canonical_hash(output['scenario']) != canonical_hash(scenario)
            or result.case_id != scenario.case_id or result.policy.policy_id != policy_id
            or not result.verified):
        raise ValueError('Modal result does not match verified immutable submitted case/policy')
    if not re.fullmatch(r'ep_[a-zA-Z0-9_-]+', result.episode_id):
        raise ValueError('Invalid remote episode identity')
    if result.trace_ref != f'episodes/{result.episode_id}/trace.jsonl':
        raise ValueError('Remote trace path does not match episode')
    provenance = output.get('execution', {})
    if (provenance.get('backend') != 'modal_cpu'
            or any(not isinstance(provenance.get(k), str) or not provenance[k]
                   for k in ('container_id', 'input_id', 'function_call_id'))):
        raise ValueError('Missing remote execution provenance')
    start, end = provenance.get('started_at_ms'), provenance.get('finished_at_ms')
    if any(not isinstance(t, (int, float)) or not math.isfinite(t) for t in (start, end)) or end < start:
        raise ValueError('Invalid worker execution interval')
    events = [json.loads(line) for line in output['trace_jsonl'].splitlines() if line.strip()]
    if not events or any(event.get('episode_id') != result.episode_id or event.get('seq') != index
                         for index, event in enumerate(events, 1)):
        raise ValueError('Trace episode identity or contiguous sequence is invalid')
    if events[0].get('kind') != 'episode.reset' or events[0].get('data', {}).get('case_id') != scenario.case_id:
        raise ValueError('Trace does not begin with the submitted case reset')
    if (events[-1].get('kind') != 'benchmark.case_finished'
            or CaseResult.model_validate(events[-1].get('data')) != result):
        raise ValueError('Trace terminal result does not match returned oracle result')
    states = [event['data'] for event in events if event.get('kind') == 'sim.state']
    if (not states or output['final_world'].get('episode_id') != result.episode_id
            or states[-1] != output['final_world']):
        raise ValueError('Final world does not match final trace state')
    if not isinstance(output['captured_disturbances'], list):
        raise ValueError('Malformed captured disturbances')
    return result, provenance


async def dispatch_cases(cases, baseline, candidate, storage, *, backend='local',
                         concurrency=4, on_progress=None):
    """Return paired lists, errors and execution evidence; never fabricate failed results.

    Callback events are synchronous dicts: queued, started, completed, failed.
    Completed events include a JSON result, role and execution timing/provenance.
    Cancellation propagates and cancels outstanding local tasks.
    """
    snapshots = validate_dispatch(cases, baseline, candidate, backend, concurrency)
    semaphore = asyncio.Semaphore(concurrency)
    response = {'baseline': [], 'candidate': [], 'errors': [], 'executions': [],
                'peak_concurrency': 0, 'backend': backend, 'concurrency': concurrency}
    active = 0
    def emit(event):
        if on_progress:
            on_progress(event)
    async def execute(payload, role, policy_id):
        nonlocal active
        identity = {'case_id': payload['case_id'], 'scenario_hash': canonical_hash(payload),
                    'policy_id': policy_id, 'role': role, 'backend': backend}
        emit({'type': 'queued', **identity})
        async with semaphore:
            active += 1
            response['peak_concurrency'] = max(response['peak_concurrency'], active)
            timing = {**identity, 'started_at_ms': time.time() * 1000}
            emit({'type': 'started', **timing, 'active_executions': active})
            try:
                # Each policy receives its own fresh validated model/environment.
                scenario = Scenario.model_validate(payload)
                if backend == 'local':
                    result, _ = await asyncio.to_thread(
                        lambda: asyncio.run(run_case(scenario, policy_id, storage)))
                    provenance = {'backend': 'local'}
                else:
                    result, provenance = await modal_case(scenario, policy_id, storage)
                if result.scenario_hash != identity['scenario_hash'] or result.policy.policy_id != policy_id or result.case_id != payload['case_id']:
                    raise ValueError('Result does not match submitted immutable case/policy')
                timing.update(finished_at_ms=time.time() * 1000, episode_id=result.episode_id,
                              status='completed', worker=provenance)
                response[role].append(result)
                emit({'type': 'completed', **timing, 'result': result.model_dump(mode='json')})
            except Exception as exc:
                timing.update(finished_at_ms=time.time() * 1000, status='failed', error_type=type(exc).__name__)
                response['errors'].append({**identity, 'error_type': type(exc).__name__})
                emit({'type': 'failed', **timing})
            finally:
                active -= 1
                response['executions'].append(timing)
    tasks = [asyncio.create_task(execute(payload, role, policy)) for payload in snapshots
             for role, policy in (('baseline', baseline), ('candidate', candidate))]
    try:
        await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    workers = [e["worker"] for e in response["executions"]
               if e.get("worker", {}).get("backend") == "modal_cpu"]
    response["actual_worker_overlap"] = max((len({w["container_id"] for w in workers
        if w["started_at_ms"] <= current["started_at_ms"] < w["finished_at_ms"]})
        for current in workers), default=0) if backend == "modal_cpu" else None
    return response


def status(storage):
    """Report verified deployment evidence without reading or exposing auth tokens."""
    import importlib.util
    installed = importlib.util.find_spec('modal')
    sdk = bool(installed and installed.origin)
    try:
        proof = storage.load('modal-verification.json')
    except (OSError, ValueError):
        proof = {}
    verified = (proof.get('deployed') is True and proof.get('worker_function_verified') is True
                and proof.get('execution_source_hash') == execution_source_hash())
    return {'id': 'modal_cpu', 'name': 'Modal CPU', 'available': sdk and verified,
            'verified': verified, 'max_concurrency': 4,
            'supported_policies': ['scripted_open_loop', 'scripted_reobserve', 'scripted_obstacle_aware'],
            'supported_environments': ['warehouse'],
            'reason': 'Deployed worker verified with real cloud episode artifacts' if sdk and verified else
                      'Install Modal SDK and deploy/verify faultline-pick worker',
            'verification': proof if verified else None}


def execution_backend_catalog(storage):
    from .policies import POLICY_IDS
    return [{'id': 'local', 'name': 'Local parallel', 'available': True, 'verified': True,
             'reason': 'Independent local environments with bounded worker threads',
             'max_concurrency': 4, 'supported_policies': POLICY_IDS,
             'supported_environments': ['camera', 'warehouse', 'physics']},
            status(storage)]


def validate_dispatch(cases, baseline, candidate, backend="local", concurrency=4):
    if backend not in ('local', 'modal_cpu'):
        raise ValueError('Unknown execution backend')
    if not 1 <= concurrency <= 4:
        raise ValueError('concurrency must be between 1 and 4')
    snapshots = [c.model_dump(mode='json') for c in cases]
    if len({c['case_id'] for c in snapshots}) != len(snapshots):
        raise ValueError('Duplicate case IDs are not allowed')
    if backend == 'modal_cpu':
        if any(p not in ('scripted_open_loop', 'scripted_reobserve', 'scripted_obstacle_aware') for p in (baseline, candidate)):
            raise ValueError('Modal supports scripted policies only')
        if any(c.get('provenance', {}).get('execution_backend', 'kinematic') == 'robosimstudio_cpu' for c in snapshots):
            raise ValueError('Native RoboSim is not installed in the Modal image')
        if any(c.get('source') != 'procedural' for c in snapshots):
            raise ValueError('Modal accepts generated/procedural cases only; captured scenes stay local')
        if any(c['initial_scene']['sensor_mode'] != 'PROCEDURAL' or c['initial_scene'].get('frame_ref') or any(d.get('frame_ref') or d['source'] != 'procedural' for d in c['disturbances']) for c in snapshots):
            raise ValueError('Camera-derived inputs must stay local')
    return snapshots


def execution_source_hash():
    """Invalidate historical verification when any cloud execution implementation changes."""
    import hashlib
    from pathlib import Path
    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for name in ('runner.py', 'engine.py', 'models.py', 'policies.py', 'kinematics.py',
                 'warehouse.py', 'robosim.py', 'oracle.py', 'storage.py'):
        digest.update(name.encode())
        digest.update((root / name).read_bytes())
    return digest.hexdigest()
