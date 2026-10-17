# Electronics kitting workflow

`ProductionLine` orchestrates four real sequential kinematic episodes: PCB module, connector kit, sensor module and enclosure into separate kit tray positions. Each stage uses the existing policy adapter, six-joint arm model, collision/path checks and independent result oracle. Selecting a frontier/Jev policy invokes that adapter for actual decisions; scripted verification reports zero model calls.

Object positions carry forward from each preceding actual final world. Each stage has a fresh policy/environment and an explicit home reset for the arm. This is a sequential kitting workflow with verified stage boundaries, not uninterrupted robot dynamics or physical electronics manufacturing. It does not solder, inspect electronics electrically, or certify hardware.

Every stage is frozen under a distinct immutable scenario ID and hash before execution. Each completed stage retains its real CaseResult, episode ID, trace and final world. The workflow stops on the first non-PASS result, preserving previous successes and leaving unexecuted stages WAITING. A transport exception or cancellation never creates a successful result.

The second stage includes a real scheduled component displacement after the first action, requiring observation recovery. Operator changes `move_component` and `reroute_next` queue for the next stage and apply before its manifest is frozen. A request during a running stage cannot rewrite that stage's manifest or history. Change records identify the exact future stage and application time.

Limits are four stages, fifty actions per stage (two hundred total), and eight minutes wall time. The caller supplies a checkpoint callback to use existing pause/stop controls; wall deadline remains bounded. Default action pacing is 0.7 seconds.

Integration:

```python
line = ProductionLine(storage, publish=publish_event, on_env=bind_environment,
                      checkpoint=session_checkpoint)
job = line.create(session_id, policy_id, delay_seconds=0.7)
session.job = asyncio.create_task(line.run(job['job_id']))
line.change(job['job_id'], 'reroute_next')
state = line.get(job['job_id'])
```

The application owns session authorization and exclusivity with other running episodes. The service emits actual episode events plus `production.started`, `production.stage_started`, `production.stage_finished`, `production.change_queued`, and `production.finished`. Saved aggregates reside in `data/production/<job_id>.json`.

Verification: a real four-stage scripted obstacle-aware workflow completes all four oracle checks. Tests also verify carried world positions, unique episode/hash evidence, next-stage rerouting without history mutation, real failure preservation and operator stop propagation. Frontier performance must be reported from an actual provider-backed run; scripted tests do not establish it.
