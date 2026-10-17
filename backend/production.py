"""Bounded electronics kitting workflow with actual stage oracles and carried object state."""
from __future__ import annotations
import asyncio
import time
import uuid
from .models import Disturbance, Event, Limits, ObjectEstimate, Task, Zone
from .policies import make_policy, redact_error
from .runner import run_case
from .storage import canonical_hash
from .warehouse import warehouse_cases

COMPONENTS = [('parcel_00', 'PCB module'), ('parcel_01', 'Connector kit'),
              ('parcel_02', 'Sensor module'), ('parcel_03', 'Enclosure')]


class ProductionLine:
    def __init__(self, storage, publish=None, on_env=None, checkpoint=None):
        self.storage, self.publish, self.on_env, self.checkpoint = storage, publish, on_env, checkpoint
        self.jobs = {}
        self.sequence = 0

    def _save(self, job):
        job['updated_at_ms'] = time.time()*1000
        self.storage.save(f"production/{job['job_id']}.json", job)

    def _emit(self, job, kind, data):
        self.sequence += 1
        if self.publish:
            self.publish(Event(kind=kind, seq=self.sequence, timestamp_ms=time.time()*1000,
                               session_id=job['session_id'], data={"job_id": job["job_id"], **data}))

    def create(self, session_id, policy_id, delay_seconds=.7, execution_backend="kinematic"):
        make_policy(policy_id)
        if execution_backend not in ('kinematic', 'robosimstudio_cpu'):
            raise ValueError('Unknown production execution backend')
        if execution_backend == 'robosimstudio_cpu':
            from .robosim import status
            if not status()['available']:
                raise ValueError('Native RoboSim runtime is unavailable')
        if not 0 <= delay_seconds <= 3:
            raise ValueError('Stage action pacing must be between 0 and 3 seconds')
        if any(job['session_id'] == session_id and job['status'] in ('QUEUED','RUNNING') for job in self.jobs.values()):
            raise ValueError('A production workflow is already active')
        job_id = 'production_' + uuid.uuid4().hex[:12]
        job = {'job_id': job_id, 'session_id': session_id, 'policy_id': policy_id,
               'name': 'Native precision part transfer line' if execution_backend == 'robosimstudio_cpu' else 'Electronics kit assembly line',
               'execution_backend': execution_backend, 'status': 'QUEUED',
               'created_at_ms': time.time()*1000, 'delay_seconds': delay_seconds,
               'current_stage': None, 'current_stage_index': None, 'completed_stages': 0, 'total_stages': 4,
               'total_actions': 0, 'total_model_calls': 0, 'pending_changes': [], 'changes': [],
               'stages': [{'id': f'stage_{i+1}', 'index': i, 'target_id': identity, 'name': f'Kit {name}', 'status': 'WAITING',
                           'result': None, 'scenario_hash': None, 'case_id': None}
                          for i,(identity,name) in enumerate(COMPONENTS)],
               'scope': 'Procedural 6R kinematic kitting; object positions carried across independently verified stages; arm resets home between stages',
               'limits': {'max_stages': 4, 'max_actions': 200, 'wall_deadline_seconds': 480},
               'error': None}
        if execution_backend == 'robosimstudio_cpu':
            names = ['Load fixture part', 'Recover displaced fixture part', 'Rework fixture transfer', 'Dispatch placement verification']
            for stage, name in zip(job['stages'], names):
                stage.update(name=name, target_id='native_cube')
            job['scope'] = 'Actual RoboSimStudio/Newton/MuJoCo CPU contacts; four independently initialized native fixture-transfer stages; fixture re-indexes part to declared pickup and resets arm/orientation/velocity between stages; prior actual poses retained as evidence'
        self.jobs[job_id] = job
        self._save(job)
        return job

    def get(self, job_id):
        if job_id in self.jobs:
            return self.jobs[job_id]
        if not job_id.startswith('production_') or not job_id[11:].isalnum():
            raise ValueError('Invalid production job ID')
        return self.storage.load(f'production/{job_id}.json')

    def list_jobs(self, session_id=None):
        """Read saved evidence; the HTTP caller must enforce ownership/access."""
        import json
        root = self.storage.path('production')
        saved = {path.stem: json.loads(path.read_text()) for path in root.glob('production_*.json')} if root.exists() else {}
        saved.update(self.jobs)
        return sorted((job for job in saved.values() if session_id is None or job['session_id'] == session_id),
                      key=lambda job: job['created_at_ms'], reverse=True)

    def change(self, job_id, change):
        job = self.get(job_id)
        if change not in ('move_component','reroute_next'):
            raise ValueError('Unknown production change')
        if job['status'] not in ('QUEUED','RUNNING'):
            raise ValueError('Production workflow is not active')
        next_index = 0 if job['current_stage'] is None else job['current_stage']+1
        if next_index >= 4:
            raise ValueError('No future stage remains; current frozen stage cannot be edited')
        entry = {'id': 'change_'+uuid.uuid4().hex[:8], 'change': change, 'stage_index': next_index,
                 'requested_at_ms': time.time()*1000, 'status': 'QUEUED_FOR_NEXT_STAGE'}
        job['pending_changes'].append(entry)
        self._save(job)
        self._emit(job,'production.change_queued',entry)
        return entry

    def _stage_case(self, job, index, previous_env):
        if job.get('execution_backend') == 'robosimstudio_cpu':
            return self._native_stage_case(job, index, previous_env)
        case = warehouse_cases(1, 90400+index)[0]
        case.case_id = f"{job['job_id']}_stage_{index+1}"
        case.name = job['stages'][index]['name']
        case.family = 'electronics_kitting'
        if previous_env:
            case.initial_scene.objects = [ObjectEstimate.model_validate({k:v for k,v in obj.model_dump().items()
                if k in ObjectEstimate.model_fields}) for obj in previous_env.world.objects]
        else:
            for offset,(identity,label) in enumerate(COMPONENTS):
                obj = next(o for o in case.initial_scene.objects if o.id == identity)
                obj.label = label
                obj.position = (1.15,1.15+offset*.22,.1)
                obj.dimensions = (.16,.12,.2)
        identity,label = COMPONENTS[index]
        case.task = Task(target_id=identity, instruction=f'Electronics kitting stage {index+1}/4: pick the {label} ({identity}) and place it in this stage outbound kit tray. Re-observe after a rejected or stale action. Do not move other components.')
        case.destination = Zone(id='outbound_bin', center=(2.9, .95+index*.25, .1), size=(.4,.24,.3))
        case.limits = Limits(max_actions=50, max_sim_seconds=120)
        case.disturbances = []
        # A declared disturbance is hidden from the policy and applied by the real engine.
        if index == 1:
            target = next(o for o in case.initial_scene.objects if o.id == identity)
            case.disturbances = [Disturbance(type='MOVE_OBJECT',object_id=identity,after_action_index=1,
                position=(target.position[0]+.18,target.position[1],target.position[2]))]
        applied = []
        for entry in list(job['pending_changes']):
            if entry['stage_index'] != index:
                continue
            if entry['change'] == 'move_component':
                target = next(o for o in case.initial_scene.objects if o.id == identity)
                target.position = (1.35, target.position[1], target.position[2])
            else:
                case.destination.center = (2.55,case.destination.center[1],.1)
            entry.update(status='APPLIED_BEFORE_STAGE_FREEZE', applied_at_ms=time.time()*1000)
            job['changes'].append(entry)
            job['pending_changes'].remove(entry)
            applied.append(entry['id'])
        case.provenance.update(workflow_id=job['job_id'], stage_index=index,
            previous_episode_id=previous_env.episode_id if previous_env else None,
            carried_state='actual_previous_final_world_objects' if previous_env else 'declared_initial_layout',
            robot_reset='home_between_stages', applied_change_ids=applied)
        # Revalidation catches mutation mistakes before immutable manifest persistence.
        return type(case).model_validate(case.model_dump())

    def _native_stage_case(self, job, index, previous_env):
        from .robosim import make_robosim_cases
        case = make_robosim_cases(1, 91400+index)[0]
        case.case_id = f"{job['job_id']}_stage_{index+1}"
        case.name = job['stages'][index]['name']
        case.family = 'native_production_transfer'
        case.task.instruction = f"Native production transfer stage {index+1}/4: move native_cube to the destination station. Grasp must lift the dynamic cube through real contacts; observe after rejected actions."
        prior_orientation = None
        if previous_env:
            previous = next(o for o in previous_env.world.objects if o.id == 'native_cube')
            prior_orientation = previous.orientation_quaternion
        case.destination.center = (.4175, .5, .025)
        case.destination.size = (.12, .12, .15)
        case.limits = Limits(max_actions=50,max_sim_seconds=120)
        case.disturbances = make_robosim_cases(2, 91400)[1].disturbances if index == 1 else []
        applied = []
        for entry in list(job['pending_changes']):
            if entry['stage_index'] != index:
                continue
            if entry['change'] == 'move_component':
                case.initial_scene.objects[0].position = (.3575,.5,.025)
            else:
                case.destination.center = (.3975,.5,.025)
            entry.update(status='APPLIED_BEFORE_STAGE_FREEZE',applied_at_ms=time.time()*1000)
            job['changes'].append(entry)
            job['pending_changes'].remove(entry)
            applied.append(entry['id'])
        case.provenance.update(workflow_id=job['job_id'],stage_index=index,
            previous_episode_id=previous_env.episode_id if previous_env else None,
            carried_state='prior_pose_recorded_fixture_reindexed_to_declared_pickup' if previous_env else 'declared_initial_layout',
            previous_final_position=previous.position if previous_env else None,
            fixture_reset={'before_position': previous.position if previous_env else None,
                           'before_quaternion': prior_orientation,
                           'after_position': case.initial_scene.objects[0].position,
                           'after_quaternion': [0,0,0,1], 'velocity_reset': True},
            previous_final_orientation=prior_orientation,
            stage_boundary_reset='fixture_reindex_to_declared_pickup_robot_home_part_upright_zero_velocity',
            applied_change_ids=applied)
        return type(case).model_validate(case.model_dump())

    async def run(self, job_id):
        job = self.get(job_id)
        if job['status'] != 'QUEUED':
            raise ValueError('Production workflow was already started')
        job['status'] = 'RUNNING'
        previous_env = None
        started = time.monotonic()
        self._save(job)
        self._emit(job,'production.started',job)
        async def checkpoint(env):
            if time.monotonic()-started >= 480:
                return 'POLICY_TIMEOUT:PRODUCTION_DEADLINE'
            return await self.checkpoint(env) if self.checkpoint else None
        try:
            for index, stage in enumerate(job['stages']):
                job['current_stage'] = job['current_stage_index'] = index
                case = self._stage_case(job,index,previous_env)
                self.storage.save_scenario(case)
                stage.update(status='RUNNING',case_id=case.case_id,scenario_hash=canonical_hash(case))
                self._save(job)
                self._emit(job,'production.stage_started',{'job_id':job_id,'stage':stage,'task':case.task.model_dump()})
                result, env = await asyncio.wait_for(run_case(case,job['policy_id'],self.storage,
                    delay_seconds=job['delay_seconds'],on_event=self.publish,on_env=self.on_env,checkpoint=checkpoint),
                    timeout=max(.01,480-(time.monotonic()-started)))
                previous_env = env
                stage.update(status=result.outcome,episode_id=result.episode_id,result=result.model_dump(mode='json'))
                job['total_actions'] += result.actions
                job['total_model_calls'] += result.model_calls
                if result.outcome == 'PASS':
                    job['completed_stages'] += 1
                self._save(job)
                self._emit(job,'production.stage_finished',{'job_id':job_id,'stage':stage})
                if result.outcome != 'PASS':
                    job.update(status='FAILED',error=f"Stage {index+1}: {result.reason}")
                    break
                await asyncio.sleep(0)
            else:
                job['status'] = 'SUCCEEDED'
        except asyncio.CancelledError:
            job.update(status='STOPPED',error='Operator stopped workflow')
            self._save(job)
            raise
        except Exception as exc:
            job.update(status='FAILED',error=redact_error(exc))
            if job['current_stage'] is not None:
                job['stages'][job['current_stage']]['status'] = 'ERROR'
        finally:
            job['wall_elapsed_ms'] = (time.monotonic()-started)*1000
            self._save(job)
            self._emit(job,'production.finished',job)
        return job
