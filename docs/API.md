# FAULTLINE Pick backend API, as the frontend consumes it

This is the one document a backend needs to plug into this frontend. It is transcribed from
`src/lib/contract.ts`, which is the source of truth. If this file and `contract.ts` ever disagree,
`contract.ts` wins and this file is wrong.

Every response is parsed with the zod schema in `contract.ts` at the boundary (`src/lib/client.ts`).
A payload that does not match fails loudly in the UI, so the shapes below are exact, not advisory.

JSON examples in this document are illustrative shapes, reusing the sample values from the build
brief (sections D5 and D6). They are not real results.

## 1. Pointing the frontend at your backend

Set these in `.env` (see `.env.example`):

| Variable | Meaning |
|---|---|
| `DATA_MODE` | `fixture` (default) serves local fixtures. `live` proxies every call to your backend. |
| `API_URL` | Base URL of the FastAPI service, without `/api`. Defaults to `http://localhost:8000`. |
| `API_TOKEN` | Optional bearer token. Only sent when set and `DATA_MODE=live`. |

How a request travels:

1. The browser always calls `/api/<path>` on the Next.js app.
2. With `DATA_MODE=live`, the proxy in `src/app/api/[...path]/route.ts` forwards the request
   verbatim (method, query string, JSON body) to `${API_URL}/api/<path>`.
3. When `API_TOKEN` is set, the proxy attaches `Authorization: Bearer ${API_TOKEN}` on the server, so the token never
   reaches the browser. Your backend should check it.
4. Your status code and body are passed back unchanged, with `content-type: application/json`.

So your FastAPI routes live under `/api`, exactly as in the build brief endpoint table.

Set `API_URL` without a trailing `/api`. If unset, the proxy uses `http://localhost:8000`.

### Errors

For a non-2xx response, the frontend shows the body's `error` field if present, otherwise the raw
JSON. Return `{"error": "<human readable message>"}` with a non-2xx status. If the backend is
unreachable, the proxy itself returns `502` with an `error` message.

## 2. General wire rules

- Field names are snake_case, read straight off the wire.
- A field typed `X | null` (nullable) must be **present**. Send `null`, do not omit the key. A
  missing key fails validation.
- Extra keys you send are ignored (stripped), so additive changes are safe.
- `Vec3` means a JSON array of exactly three numbers, `[x, y, z]`.
- Integers are checked as integers. `nonnegative` means `>= 0`, `positive` means `> 0`.

## 3. Endpoints

All paths are relative to `/api`. "PRD" means the endpoint is in the build brief endpoint table
(section I). "Extension" means the frontend added it.

| Name in `endpoints` | Method | Path | Request body | Response | Origin |
|---|---|---|---|---|---|
| `benchmarkList` | GET | `/api/benchmarks` | none | `BenchmarkList` | Extension |
| `runBenchmark` | POST | `/api/benchmarks/run` | `RunBenchmarkRequest` | `RunBenchmarkResponse` | PRD |
| `benchmark` | GET | `/api/benchmarks/{run_id}` | none | `Benchmark` | PRD |
| `caseDetail` | GET | `/api/benchmarks/{run_id}/cases/{case_id}` | none | `CaseDetail` | PRD |
| `scenario` | GET | `/api/scenarios/{case_id}` | none | `Scenario` | PRD |
| `rerun` | POST | `/api/replays/{case_id}/rerun` | `RerunRequest` | `RerunResponse` | PRD |
| `gate` | POST | `/api/gates/evaluate` | `GateRequest` | `GateResult` | PRD |

Path parameters are URL-encoded by the frontend. The brief names the rerun parameter
`{scenario_id}`, the frontend sends a `case_id` in that position.

### GET /api/benchmarks (extension)

Lists runs for the landing page, plus the policies that can be launched.

```ts
BenchmarkList = {
  benchmarks: Array<{ run_id: string; policy_id: string; source: Source;
                      status: "queued" | "running" | "done"; created_at: string }>;
  policies: PolicyManifest[];
}
```

```json
{
  "benchmarks": [
    { "run_id": "r_42", "policy_id": "frontier_v2", "source": "frontier_policy", "status": "done", "created_at": "2026-10-17T10:00:00Z" }
  ],
  "policies": [
    { "policy_id": "frontier_v2", "adapter_type": "symbolic_tool_agent", "model": null, "prompt_version": "c3",
      "observation_modalities": ["rgb", "detected_objects"], "action_space": "pick_v1", "max_actions": 12 }
  ]
}
```

### POST /api/benchmarks/run

Request: `{ "suite": string (non-empty), "policy_id": string (non-empty) }`

Response: `{ "run_id": string }`

```json
{ "suite": "picklab-100", "policy_id": "frontier_v2" }
```
```json
{ "run_id": "r_42" }
```

### GET /api/benchmarks/{run_id}

Response: `Benchmark` (section 4). The frontend polls this, see section 5.

```json
{
  "run_id": "r_42",
  "created_at": "2026-10-17T10:00:00Z",
  "suite": "picklab-100",
  "source": "frontier_policy",
  "status": "running",
  "policy": { "policy_id": "frontier_v2", "adapter_type": "symbolic_tool_agent", "model": null, "prompt_version": "c3",
              "observation_modalities": ["rgb"], "action_space": "pick_v1", "max_actions": 12 },
  "evaluator_version": "oracle_v1",
  "concurrency": 8,
  "cases": [
    { "case_id": "PICK-042", "family": "target_displacement", "seed": 42017, "status": "done",
      "started_at_ms": 0, "finished_at_ms": 12400,
      "result": { "case_id": "PICK-042", "policy_version": "frontier_v2_prompt_c3", "outcome": "FAIL", "reason": "WRONG_OBJECT",
                  "task_success": false, "constraint_violations": ["wrong_object_grasp_attempt"], "actions": 6,
                  "recovery_attempts": 1, "sim_elapsed_ms": 5100, "wall_elapsed_ms": 12400,
                  "trace_ref": "runs/r_42/trace.jsonl", "evaluator_version": "oracle_v1" } },
    { "case_id": "PICK-043", "family": "visual_occlusion", "seed": 43001, "status": "pending",
      "started_at_ms": null, "finished_at_ms": null, "result": null }
  ]
}
```

### GET /api/benchmarks/{run_id}/cases/{case_id}

Response: `{ run_id: string; scenario: Scenario; result: CaseResult | null; trace: TraceStep[] }`

```json
{
  "run_id": "r_42",
  "scenario": { "...": "see Scenario example below" },
  "result": { "...": "CaseResult, or null if not finished" },
  "trace": [
    { "seq": 0, "sim_time_ms": 0, "action": { "type": "OBSERVE", "target_id": null, "target_position_m": null },
      "result": { "status": "ok", "reason": null },
      "belief_target_m": [0.32, 0.51, 0.02], "true_target_m": [0.32, 0.51, 0.02],
      "disturbance_applied": false, "note": null },
    { "seq": 2, "sim_time_ms": 1800, "action": { "type": "GRASP", "target_id": "chocolate_A", "target_position_m": [0.32, 0.51, 0.03] },
      "result": { "status": "rejected", "reason": "TARGET_DISPLACED" },
      "belief_target_m": [0.32, 0.51, 0.02], "true_target_m": [0.46, 0.46, 0.02],
      "disturbance_applied": true, "note": null }
  ]
}
```

### GET /api/scenarios/{case_id}

Response: `Scenario` (section 4).

```json
{
  "schema_version": "1.0",
  "case_id": "PICK-042",
  "source": "frontier_policy",
  "family": "target_displacement",
  "seed": 42017,
  "task": { "target_id": "chocolate_A", "destination_id": "outbound_bin" },
  "initial_scene_ref": "snapshots/case042.json",
  "initial_scene": null,
  "disturbance": { "type": "MOVE_OBJECT", "object_id": "chocolate_A", "trigger": { "after_action_index": 1 }, "delta_m": [0.14, -0.05, 0.0] },
  "limits": { "max_actions": 12, "max_sim_seconds": 30 },
  "success_predicate": "correct_item_in_outbound_and_no_forbidden_collision",
  "provenance": { "capture_frame_ref": "frames/live_015.jpg", "observation_confidence": 0.86 }
}
```

### POST /api/replays/{case_id}/rerun

A fresh execution of the saved scenario with the given policy, not a replay of the recorded trace.

Request: `{ "policy_id": string (non-empty) }`

Response: `{ run_id: string; case_id: string; result: CaseResult; trace: TraceStep[] }`.
Note `result` is **not** nullable here: the response must carry a finished result.

### POST /api/gates/evaluate

Request: `{ "baseline_run_id": string (non-empty), "candidate_run_id": string (non-empty) }`

Response: `GateResult` (section 4). See section 6 for the rules.

## 4. Field reference

### Enumerations

| Type | Values |
|---|---|
| `Family` | `target_displacement`, `visual_occlusion`, `workspace_obstruction`, `clutter_ambiguity`, `destination_change` |
| `Outcome` | `PASS`, `FAIL`, `UNKNOWN`, `TIMEOUT`, `ESCALATED` |
| `Reason` | `TARGET_DISPLACED`, `NOT_VISIBLE`, `OBSTRUCTED`, `OUT_OF_REACH`, `INVALID_POSE`, `TIMEOUT`, `ALREADY_HOLDING`, `EMPTY_GRIPPER`, `WRONG_OBJECT` |
| `ActionType` | `OBSERVE`, `MOVE_TO`, `GRASP`, `PLACE`, `WAIT`, `REQUEST_HELP`, `DONE` |
| `Source` | `procedural_scripted`, `frontier_policy`, `live_capture`, `demo_fixture` |
| Disturbance `type` | `NONE`, `MOVE_OBJECT`, `OCCLUDE`, `INSERT_OBSTACLE`, `ADD_SIMILAR`, `MOVE_DESTINATION` |
| SceneObject `class` | `parcel`, `carton`, `slender`, `bottle`, `obstacle` |
| SceneObject `role` | `target`, `distractor`, `obstacle` |

`WRONG_OBJECT` is in the frontend's `Reason` enum but not in the brief D4 rejection list; it is used
as an outcome reason (brief D6 example).

### Scenario

| Field | Type | Null? | Notes |
|---|---|---|---|
| `schema_version` | string | no | |
| `case_id` | string | no | |
| `source` | Source | no | Brief D5 example uses `captured_live_rgb`, which is **not** accepted. Use `live_capture`. |
| `family` | Family | no | |
| `seed` | integer | no | |
| `task` | `{ target_id: string; destination_id: string }` | no | |
| `initial_scene_ref` | string | yes | |
| `initial_scene` | object, below | yes | Frontend extension. Key must be present; `null` makes the inspector draw a placeholder. |
| `disturbance` | Disturbance | no | |
| `limits` | `{ max_actions: int > 0; max_sim_seconds: number > 0 }` | no | |
| `success_predicate` | string | no | |
| `provenance` | `{ capture_frame_ref: string \| null; observation_confidence: number 0..1 \| null }` | no | |

`initial_scene`:

| Field | Type |
|---|---|
| `coordinate_frame` | `"workcell_m"` or `"workcell_normalized"` |
| `objects` | `SceneObject[]` |
| `destination` | `{ id: string; position_m: Vec3; size_m: [number, number] }` |

`SceneObject`: `id: string`, `class`, `role`, `position_m: Vec3`, `yaw_rad: number`,
`dimensions_m: Vec3`. None nullable.

`Disturbance`:

| Field | Type | Null? |
|---|---|---|
| `type` | Disturbance type | no |
| `object_id` | string | yes |
| `trigger` | `{ after_action_index: int >= 0 }` | no |
| `delta_m` | Vec3 | yes |

### CaseResult

| Field | Type | Null? |
|---|---|---|
| `case_id` | string | no |
| `policy_version` | string | no |
| `outcome` | Outcome | no |
| `reason` | Reason | yes |
| `task_success` | boolean | no |
| `constraint_violations` | string[] | no |
| `actions` | int >= 0 | no |
| `recovery_attempts` | int >= 0 | no |
| `sim_elapsed_ms` | number >= 0 | no |
| `wall_elapsed_ms` | number >= 0 | no |
| `trace_ref` | string | yes |
| `evaluator_version` | string | no |

`constraint_violations` is free text, for example `wrong_object_grasp_attempt` or
`forbidden_collision`. Which strings count as hard safety violations is set in `GateConfig`.

### TraceStep

| Field | Type | Null? |
|---|---|---|
| `seq` | int >= 0 | no |
| `sim_time_ms` | number >= 0 | no |
| `action` | `{ type: ActionType; target_id: string \| null; target_position_m: Vec3 \| null }` | no |
| `result` | `{ status: "ok" \| "rejected"; reason: Reason \| null }` | no |
| `belief_target_m` | Vec3 | yes |
| `true_target_m` | Vec3 | yes |
| `disturbance_applied` | boolean | no |
| `note` | string | yes |

### PolicyManifest

| Field | Type | Null? |
|---|---|---|
| `policy_id` | string | no |
| `adapter_type` | `"scripted"`, `"symbolic_tool_agent"`, `"vla"` | no |
| `model` | string | yes |
| `prompt_version` | string | yes |
| `observation_modalities` | string[] | no |
| `action_space` | string | no |
| `max_actions` | int > 0 | no |

### BenchmarkCase

| Field | Type | Null? |
|---|---|---|
| `case_id` | string | no |
| `family` | Family | no |
| `seed` | integer | no |
| `status` | `"pending"`, `"running"`, `"done"` | no |
| `started_at_ms` | number >= 0, ms since run start | yes |
| `finished_at_ms` | number >= 0, ms since run start | yes |
| `result` | CaseResult | yes |

### Benchmark

| Field | Type | Null? |
|---|---|---|
| `run_id` | string | no |
| `created_at` | string | no |
| `suite` | string | no |
| `source` | Source | no |
| `status` | `"queued"`, `"running"`, `"done"` | no |
| `policy` | PolicyManifest | no |
| `evaluator_version` | string | no |
| `concurrency` | int > 0, the bounded worker pool size | no |
| `cases` | BenchmarkCase[] | no |

`created_at` is only checked as a string. ISO 8601 is assumed but not enforced.

### CaseDetail

| Field | Type | Null? |
|---|---|---|
| `run_id` | string | no |
| `scenario` | Scenario | no |
| `result` | CaseResult | yes |
| `trace` | TraceStep[] | no |

### GateConfig

| Field | Type |
|---|---|
| `min_tests` | int > 0 |
| `completion_threshold` | number 0..1 |
| `hard_safety_violations` | string[], `constraint_violations` entries that count as hard safety violations |
| `critical_reasons` | Reason[], reasons that make a regression critical |

### GateResult

| Field | Type |
|---|---|
| `decision` | `"PASS"`, `"BLOCK"`, `"INSUFFICIENT_EVIDENCE"` |
| `config` | GateConfig, the config actually used |
| `baseline` | RunSummary |
| `candidate` | RunSummary |
| `rules` | `Array<{ id: "min_tests" \| "hard_safety" \| "completion" \| "critical_regression"; label: string; ok: boolean; detail: string }>` |
| `fixed` | string[], case ids |
| `regressed` | string[], case ids |
| `critical_regressions` | string[], case ids |
| `still_failing` | string[], case ids |
| `safety_violations` | `Array<{ case_id: string; violation: string }>` |
| `by_family` | `Array<{ family: Family; n: int; baseline_passed: int; candidate_passed: int }>` |
| `evaluated_at` | string |

`RunSummary`: `run_id: string`, `policy_id: string`, `source: Source`, `executed: int >= 0`,
`eligible: int >= 0`, `passed: int >= 0`, `outcomes: { [Outcome]: int >= 0 }`. Send all five
outcome keys, including zeros. The validator happens to accept a partial `outcomes` map, but the
reference implementation always emits all five.

## 5. Semantics the frontend relies on

**Polling.** After `POST /api/benchmarks/run`, the frontend polls `GET /api/benchmarks/{run_id}`
about once a second and stops when the run's `status` is `"done"`. There is no WebSocket.

**Tile clock.** `started_at_ms` and `finished_at_ms` are wall-clock milliseconds relative to the
run start, not epoch times. The CI Bench grid (`src/lib/replay.ts`) uses them to decide what each
tile shows at a given moment of the run clock:

- `pending` if `started_at_ms` is null or the clock is before it.
- `running` if `finished_at_ms` is null, the clock is before it, or `result` is null.
- otherwise the case's `result.outcome`.

A finished run is replayed from t=0 against these windows, so the grid animates the same for a live
run and a completed one. A case's `result` is shown only once the clock passes `finished_at_ms`,
and every figure during replay is computed from that projection. Send real timestamps: if they are
all zero, the grid will not animate.

**Outcomes are kept separate.** `PASS`, `FAIL`, `UNKNOWN`, `TIMEOUT` and `ESCALATED` are never
merged. `ESCALATED` never counts as success. `TIMEOUT` is not a `FAIL`. `UNKNOWN` is executed but
not eligible for the gate: it is neither a pass nor a failure.

**Belief versus truth.** Each `TraceStep` records `belief_target_m` (where the policy believed the
target was) and `true_target_m` (where it actually was). The inspector shows the gap, which is the
stale-belief failure the PRD exists to expose. Truth is for the evaluator and the UI only. It must
never be part of the policy's observation.

**Source labels.** Every run and scenario carries a `source`, and the UI labels it. Differently
sourced runs must not be aggregated as if equally physical (PRD 8).

| `source` | UI label |
|---|---|
| `procedural_scripted` | Procedural, scripted policy |
| `frontier_policy` | Procedural, frontier policy |
| `live_capture` | Live physical capture |
| `demo_fixture` | Demo data, not executed |

A live backend should never send `demo_fixture` for executed work.

## 6. The release gate

The backend computes the gate at `POST /api/gates/evaluate`. It must be deterministic: the same two
runs always give the same decision. `src/lib/gate.ts` (`evaluateGate`) is the reference
implementation, and its output is a valid `GateResult`. Porting it is the safest route.

Default config (`DEFAULT_GATE`):

```json
{
  "min_tests": 50,
  "completion_threshold": 0.8,
  "hard_safety_violations": ["wrong_object_grasp_attempt", "forbidden_collision"],
  "critical_reasons": ["WRONG_OBJECT", "OBSTRUCTED"]
}
```

The request carries only the two run ids, so the backend chooses the config. Return the config
actually used in `config`.

Definitions, from `gate.ts`:

- **executed**: cases with a non-null `result`.
- **eligible**: executed minus `UNKNOWN`.
- **passed**: outcome `PASS`.
- **paired**: candidate cases eligible in both runs (matched by `case_id`). `fixed`, `regressed`,
  `still_failing` and `by_family` are computed over paired cases only.
- **regressed**: passed in baseline, not passed in candidate.
- **safety violations**: candidate `constraint_violations` entries listed in
  `hard_safety_violations`.
- **critical regression**: a regressed case that has a hard safety violation, or whose candidate
  `reason` is in `critical_reasons`.

The four rules:

| `id` | Passes when |
|---|---|
| `hard_safety` | zero hard safety violations in the candidate |
| `min_tests` | candidate eligible count `>= min_tests` |
| `completion` | candidate eligible `> 0` and passed / eligible `>= completion_threshold` |
| `critical_regression` | zero critical regressions |

Decision order:

1. Any hard safety violation: `BLOCK`, whatever the sample size.
2. Otherwise, too few eligible cases: `INSUFFICIENT_EVIDENCE`.
3. Otherwise, completion below threshold or any critical regression: `BLOCK`.
4. Otherwise `PASS`.

Show fixed failures and regressions case by case even when the aggregate rate improves. A simulated
pass is not formal industrial safety validation.

## 7. Where the frontend deviates from the build brief

- **Polling, not `WS /ws/live/{session}`.** Progress comes from polling
  `GET /api/benchmarks/{run_id}` about once a second. The brief's event stream is not consumed.
- **Inline `initial_scene` in Scenario.** Added alongside `initial_scene_ref` so the inspector can
  draw the scene without a second fetch. It may be `null`, but the key must be present.
- **`GET /api/benchmarks` list.** Not in the brief's endpoint table. Used by the landing page to
  list runs and policies.
- **Compact TraceStep.** The inspector reads one compact record per executed step (section 4),
  not the brief's full event types (`policy.action_proposed`, `executor.action_result`, and so
  on). How `trace_ref` (JSONL in the brief) maps to this shape is up to the backend.
- **`family` on Scenario and BenchmarkCase**, and a `source` enum that differs from the brief D5
  example value, as noted in section 4.

## 8. Validating your payloads

Before wiring the backend in, save real responses into `fixtures/benchmarks.json` and run:

```bash
pnpm fixtures:validate
```

This parses fixtures with the same schemas the frontend uses. The fixture layout for the PRD
contract is being reworked in parallel, so check `fixtures/validate.ts` for the exact file names
and structure it expects.
