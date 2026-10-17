# Forkbench backend API

Handoff doc for the Modal (Python) backend. The Next.js frontend is already built against this
contract. If your service answers these three endpoints with these shapes, the dashboard works.

The authoritative source is `src/lib/contract.ts` (zod). This document transcribes it. The contract
is frozen: add optional fields only, never rename or remove.

---

## 1. Pointing the frontend at the backend

The frontend never calls your service directly. Every component calls `/api/<path>` on the Next.js
app, and `src/app/api/[...path]/route.ts` decides where the bytes come from.

```bash
# .env
DATA_MODE=live
API_URL=https://<org>--<app>.modal.run
```

Behaviour:

- `DATA_MODE=fixture` (the default) serves everything from `fixtures/*.json` locally.
- `DATA_MODE=live` proxies the request verbatim to `API_URL`. Path, query string, method and body
  are passed through unchanged. `content-type: application/json` is set on the way out.
- If `API_URL` is unset in live mode the proxy falls back to `http://localhost:8787`, which is handy
  for running your handler locally before deploying.
- If your service is unreachable the proxy returns HTTP 502 with `{"error": "..."}`. It does not
  retry.

So a browser request to `/api/runs/run-demo` becomes `GET https://<org>--<app>.modal.run/runs/run-demo`.
Mount your routes at the root of the Modal web app, with no `/api` prefix.

CORS is not a concern. The browser only ever talks to the Next.js origin.

---

## 2. Endpoints

### 2.1 `GET /environments`

The catalogue shown on the drop screen. No request body, no query parameters.

Response:

```json
{
  "environments": [
    {
      "id": "kitchen-counter",
      "name": "Kitchen Counter",
      "blurb": "Domestic clutter, reflective surfaces and a tight pour zone.",
      "objects": ["mug", "tray", "kettle", "sponge"],
      "difficulty": "medium",
      "tasks": [
        "Pick up the red mug and place it on the tray",
        "Move the sponge into the sink caddy",
        "Set the kettle back on its base"
      ]
    }
  ]
}
```

| Field        | JSON type       | Constraints                     | Meaning                                              |
| ------------ | --------------- | ------------------------------- | ---------------------------------------------------- |
| `id`         | string          | required                        | Stable key, sent back as `environmentId` on `POST /runs`. |
| `name`       | string          | required                        | Display name.                                        |
| `blurb`      | string          | required                        | One line of flavour under the name.                  |
| `objects`    | array of string | required, may be empty          | Props present in the scene.                          |
| `difficulty` | string          | `easy` \| `medium` \| `hard`    | Rendered as a badge.                                 |
| `tasks`      | array of string | required, may be empty          | Suggested tasks, offered as one-tap chips.           |

### 2.2 `POST /runs`

Starts a fan-out. Returns immediately. Do not block until the rollouts finish.

Request body:

```json
{
  "environmentId": "kitchen-counter",
  "task": "Pick up the red mug and place it on the tray",
  "fanout": 100
}
```

| Field           | JSON type | Constraints                      | Meaning                           |
| --------------- | --------- | -------------------------------- | --------------------------------- |
| `environmentId` | string    | min length 1                     | An `id` from `GET /environments`. |
| `task`          | string    | min length 3, max length 240     | Natural-language task.            |
| `fanout`        | integer   | min 1, max 256                   | How many randomised rollouts.     |

Response:

```json
{ "ok": true, "runId": "run-demo", "error": null }
```

| Field   | JSON type       | Constraints        | Meaning                                                 |
| ------- | --------------- | ------------------ | ------------------------------------------------------- |
| `ok`    | boolean         | required           | Whether the run was accepted.                           |
| `runId` | string or null  | nullable, required | The id to poll. Null when `ok` is false.                |
| `error` | string or null  | nullable, required | Human-readable reason. Null when `ok` is true.          |

Both `runId` and `error` must be present as keys. Use `null`, not omission. Reject bad input with
HTTP 200 and `{"ok": false, "runId": null, "error": "..."}`, since the client reads `error` and shows
it on the drop screen. Non-200 responses surface as a thrown error instead.

An `environmentId` that is not in your `GET /environments` catalogue must be rejected this way,
never replaced with a default. The run page titles itself from the run's own `environmentName`,
so a silent substitution shows the user a run in an environment they never chose. The fixture
server behaves the same way: it answers `{"ok": false, "runId": null, "error": "Unknown environment \"<id>\"."}`.

### 2.3 `GET /runs/:id`

The whole run, polled while it is in flight. Returns a `Run` object at the top level, not wrapped.

Example, with the `sims` array trimmed to 2 entries out of a fan-out of 100:

```json
{
  "id": "run-live",
  "createdAt": "2026-10-17T10:42:21.683Z",
  "policy": { "name": "pi0-fast", "commit": "a3f91c2", "branch": "feat/grasp-refine" },
  "environmentId": "warehouse-shelf",
  "environmentName": "Warehouse Shelf",
  "task": "Pick the labelled carton from the middle bin",
  "fanout": 100,
  "concurrency": 32,
  "stage": "rollout",
  "progress": { "label": "Running rollouts", "done": 32, "total": 100 },
  "sims": [
    {
      "id": "sim-000",
      "seed": 1606008838,
      "variant": {
        "lighting": 0.48732770594069735,
        "friction": 0.6720421036239713,
        "objectDx": -0.23188461689278483,
        "objectDy": -0.2848399782553315,
        "distractors": 2,
        "cameraJitter": 0.758311128616333
      },
      "status": "failed",
      "startOffsetMs": 125,
      "durationMs": 5650,
      "elbow": 1,
      "failMode": "collision",
      "failAt": 0.29221188408788296,
      "metrics": { "reward": 0.16, "steps": 113, "graspAttempts": 1 }
    },
    {
      "id": "sim-032",
      "seed": 132489417,
      "variant": {
        "lighting": 0.5103408998576924,
        "friction": 0.44245594684034584,
        "objectDx": 0.06817305367439985,
        "objectDy": 0.18268981482833624,
        "distractors": 0,
        "cameraJitter": 0.19780512701254338
      },
      "status": "running",
      "startOffsetMs": 5773,
      "durationMs": 5063,
      "elbow": -1,
      "failMode": null,
      "failAt": null,
      "metrics": { "reward": 0.917, "steps": 101, "graspAttempts": 1 }
    }
  ],
  "gate": {
    "metric": "pass_rate",
    "threshold": 0.8,
    "regressionTolerancePp": 2,
    "baseline": { "ref": "main@7d21e0b", "passRate": 0.82, "n": 100 }
  }
}
```

Return every rollout on every poll, including the ones still queued. The client renders the full
grid from the first response, so the cells must exist before they start. `sims.length` should equal
`fanout`.

For an unknown id, return a non-200 with `{"error": "..."}`. The client shows that string.

---

## 3. Field reference

### `Run`

| Field             | JSON type | Constraints                                                      | Meaning                                                   |
| ----------------- | --------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| `id`              | string    | required                                                          | Run id, as returned by `POST /runs`.                      |
| `createdAt`       | string    | required, any string, ISO 8601 in practice                        | When the run was created.                                 |
| `policy`          | object    | `{ name, commit, branch }`, all required strings                  | Which policy build is under test.                         |
| `environmentId`   | string    | required                                                          | The environment this run uses.                            |
| `environmentName` | string    | required                                                          | Display name, so the client does not need a second fetch. |
| `task`            | string    | required                                                          | The task text submitted on the drop screen.               |
| `fanout`          | integer   | positive                                                          | Number of rollouts requested.                             |
| `concurrency`     | integer   | positive                                                          | Worker-pool size. See the timing contract.                |
| `stage`           | string    | `provisioning` \| `booting` \| `rollout` \| `scoring` \| `done`    | Coarse run-level phase, shown in the header.              |
| `progress`        | object    | `{ label: string, done: int >= 0, total: int >= 0 }`              | Progress bar. `label` is free text.                       |
| `sims`            | array     | array of `Sim`, may be empty                                      | Every rollout, queued ones included.                      |
| `gate`            | object    | `Gate`, required, never null                                      | The merge gate for this run.                              |

### `Sim`

| Field                 | JSON type      | Constraints                                                            | Meaning                                                            |
| --------------------- | -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `id`                  | string         | required, unique within the run                                          | Cell identity. Must be stable across polls.                        |
| `seed`                | integer        | required                                                                 | Randomisation seed. Also seeds the client's cosmetic scene layout.  |
| `variant`             | object         | `Variant`, required                                                      | The domain randomisation applied to this rollout.                  |
| `status`              | string         | `queued` \| `booting` \| `running` \| `passed` \| `failed`               | Authoritative only after the episode window closes. See section 4. |
| `startOffsetMs`       | number         | >= 0                                                                     | Episode start, in ms since run start.                              |
| `durationMs`          | number         | > 0                                                                      | Episode length in ms.                                              |
| `elbow`               | number         | exactly `-1` or `1`                                                      | Which way the arm's elbow bends. Cosmetic only.                    |
| `failMode`            | string or null | nullable, one of the five fail modes below                               | How the rollout went wrong. Null on a clean run.                   |
| `failAt`              | number or null | nullable, 0 to 1 inclusive                                               | Progress through the episode where it went wrong. Null if clean.   |
| `metrics.reward`      | number         | required, unbounded                                                      | Episode reward.                                                    |
| `metrics.steps`       | integer        | >= 0                                                                     | Control steps taken.                                               |
| `metrics.graspAttempts` | integer      | >= 0                                                                     | Number of grasp attempts.                                          |

`failMode` values: `missed_approach`, `grasp_slip`, `collision`, `dropped_outside`, `timeout`.

`failMode` and `failAt` travel together. If one is non-null the other should be too: the client
reveals the failure at `startOffsetMs + failAt * durationMs`, so a `failMode` with a null `failAt`
cannot be placed on the timeline.

`metrics` is required on every rollout, including queued ones. Send zeros if you have nothing yet.

### `Variant`

| Field          | JSON type | Constraints          | Meaning                                       |
| -------------- | --------- | -------------------- | --------------------------------------------- |
| `lighting`     | number    | 0 to 1               | Scene brightness.                             |
| `friction`     | number    | 0 to 2               | Surface friction multiplier.                  |
| `objectDx`     | number    | -1 to 1              | Object offset along x.                        |
| `objectDy`     | number    | -1 to 1              | Object offset along y.                        |
| `distractors`  | integer   | 0 to 6               | Clutter objects added to the scene.           |
| `cameraJitter` | number    | 0 to 1               | Camera pose noise.                            |

All six are required. There is no partial `Variant`.

### `Gate`

| Field                   | JSON type      | Constraints                                     | Meaning                                                              |
| ----------------------- | -------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `metric`                | string         | the literal `"pass_rate"`                        | Only supported gate metric today.                                     |
| `threshold`             | number         | 0 to 1                                           | Required pass rate.                                                   |
| `regressionTolerancePp` | number         | 0 to 100                                         | How far below baseline a run may land, in percentage points.           |
| `baseline`              | object or null | `{ ref: string, passRate: 0..1, n: int > 0 }`    | The previous green run on the default branch. Null on a first run.     |

`gate` itself is never null. `gate.baseline` is the only nullable part. The client evaluates the
gate itself from `sims` plus `gate`, so you do not send a verdict. It applies the threshold to the
lower bound of a 90% Wilson interval over the settled rollouts, and the regression check to the
point estimate. Settled means `passed` or `failed`.

---

## 4. The timing contract

This is the section to get right. The grid animates 100 arms at 60fps while polling once a second,
so the client cannot wait on the network for motion. It replays each episode against its own clock.

**The episode is a script, not a measurement.** `startOffsetMs` and `durationMs` define a window
relative to run start. The client draws the arm by interpolating a pick-and-place trajectory across
that window. Between polls nothing from the backend is consulted. That is what keeps the grid
smooth. Pick values that reflect real wall-clock behaviour, because the user is watching them play
out in real time.

**The client polls `GET /runs/:id` roughly every second, and stops when `stage` is `"done"`.** Set
`"done"` once every rollout has settled. A backend that never sends it is polled for as long as the
tab stays open. Every poll returns the full run. Keep the
response cheap enough to serve at that rate. Values may change between polls, but `sim.id` ordering
and identity must not.

**Report failures the moment the harness detects them.** `failMode` and `failAt` must appear
mid-episode, as soon as they are known, not only once the rollout completes. The client reveals the
failure at `startOffsetMs + failAt * durationMs`. If a doomed rollout only gets its `failMode` at
completion, it animates as a clean success and then snaps red at the end, which reads as a bug.
Setting `failMode` and `failAt` while `status` is still `running` is correct and expected.

**`status` is authoritative only after the window closes.** Until the client clock passes
`startOffsetMs + durationMs`, the cell state comes from the clock: queued, booting, then running. At
and after that point the client takes `status`, and accepts it only if it is `passed` or `failed`.
A rollout the backend still calls `running` past its own estimate is treated as an overrun and keeps
animating, it does not count as a pass. Practical consequence: do not leave a finished rollout in
`running`, and do not send a `durationMs` far shorter than the real episode.

**`concurrency` should be the real worker-pool size.** Rollouts beyond the first `concurrency` are
expected to have later `startOffsetMs`, so the UI renders the queue draining in waves. In the
fixture, `concurrency` is 32 with a `fanout` of 100, and the queued rollouts carry start offsets well
past the first wave. If you report a `concurrency` that does not match the offsets you emit, the
queue visualisation and the real behaviour disagree.

**Monotonicity.** Once a rollout reports `passed` or `failed`, do not move it back to `running`. Once
`failAt` is set, do not change it. The client assumes both.

---

## 5. Minimum viable backend

The smallest thing that drives the UI end to end:

1. `GET /environments` returning a static list. You can serve the contents of
   `fixtures/environments.json` as-is.
2. `POST /runs` that validates the three fields, allocates a run id, kicks off the fan-out
   asynchronously, and returns `{"ok": true, "runId": "...", "error": null}` straight away.
3. `GET /runs/:id` returning the full `Run` with all `fanout` rollouts present from the first poll,
   queued ones included, each with a `variant`, a `startOffsetMs`, a `durationMs`, an `elbow` of
   `-1` or `1`, and a `metrics` object.
4. Update `status`, `failMode`, `failAt` and `metrics` in place as rollouts progress, and move
   `stage` and `progress` along with them.
5. A `gate` on every response. Hardcode `threshold` and `regressionTolerancePp` if you have no
   config yet, and send `"baseline": null` until you have a previous green run to compare against.

Not required for the UI: per-frame trajectories, video, logs. The client synthesises the arm motion
from `seed`, `variant`, `elbow`, `failMode` and `failAt`.

---

## 6. Validating your payloads

`fixtures/validate.ts` parses fixtures with the exact schemas the frontend parses responses with. To
check a payload your backend produces, drop it into `fixtures/runs.json` (the file is a JSON array of
`Run` objects, looked up by `id`) and run:

```bash
pnpm fixtures:validate
```

It reports schema failures per endpoint, and it also asserts structural invariants: `sims.length`
must equal `fanout`, and rollout ids must be unique within a run. Note that the script additionally
requires the fixture file to keep its demo runs `run-demo`, `run-live` and `run-regression` with
their specific properties, so add your run alongside them rather than replacing them.

`pnpm check` runs the typecheck, the unit tests and the fixture validation together.
