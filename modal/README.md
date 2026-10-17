# Forkbench backend on Modal (scaffold)

This is scaffolding, written to unblock integration. It is not a working simulator.
It serves the three routes the Forkbench frontend needs, with payloads that match the
frozen contract in `src/lib/contract.ts`, so the frontend can be pointed at a real
deployment today. Every rollout returns a labelled placeholder. Treat this file and
`app.py` as a starting point, and feel free to replace either of them wholesale.

## Setup

```bash
pip install modal
modal setup          # opens a browser to authenticate
```

## Run it

```bash
modal serve modal/app.py     # local dev, hot reloads, prints a temporary URL
modal deploy modal/app.py    # persistent deployment, prints the stable URL
```

Both commands print the web endpoint URL for the `api` function. It looks like
`https://<workspace>--forkbench-api-api.modal.run`. Use whatever the CLI prints.
To find it again later:

```bash
modal app list
modal app history forkbench-api
```

## Point the frontend at it

In the repo root `.env`:

```
DATA_MODE=live
API_URL=https://<the URL modal printed>
```

`src/app/api/[...path]/route.ts` then proxies `/api/*` straight through, so no
component code changes. Leave `DATA_MODE` unset or set it to `fixture` to go back to
the local fixture engine.

Quick check once deployed:

```bash
curl "$API_URL/environments"
curl -X POST "$API_URL/runs" -H 'content-type: application/json' \
  -d '{"environmentId":"lab-bench","task":"Place the pipette back in the rack","fanout":4}'
curl "$API_URL/runs/<runId from the response>"
```

## Routes

| Method | Path             | Response                       |
| ------ | ---------------- | ------------------------------ |
| GET    | `/environments`  | `{ environments: Environment[] }` |
| POST   | `/runs`          | `{ ok, runId, error }`         |
| GET    | `/runs/{run_id}` | `Run`                          |

## What is stubbed

- **`run_rollout` in `app.py` is the only function you must implement.** It sleeps for
  two seconds and reports a pass with zeroed metrics. Nothing in it touches a
  simulator. The comment block above it states exactly what the return value must
  contain and when to call `report(fail_mode, fail_at)`.
- **`ROLLOUT_GPU` is `None`.** Set it to whatever GPU the simulator needs, or drop the
  `gpu=` argument if rollouts are CPU only.
- **`MAX_CONCURRENCY` is the worker pool size** and is reported to the frontend as
  `Run.concurrency`. Keep the two in step, the UI draws the queue against it.
- **`current_policy()` reads `POLICY_NAME`, `POLICY_COMMIT` and `POLICY_BRANCH` from
  the environment** and falls back to `unset`. Wire it to whatever submits the run.
- **`current_gate()` always returns `baseline: null`** because no run history is kept.
  Once runs are persisted, look up the last passing run on the default branch.
  `GATE_THRESHOLD` and `GATE_REGRESSION_TOLERANCE_PP` are defaults, not measurements.
- **Run state lives in a `modal.Dict`** keyed by run id, with one key per rollout so
  concurrent workers never clobber each other. Nothing is ever evicted. Swap in a
  Volume or a database if you need history or cross-run queries.
- **`draw_variant` draws domain randomisation in Python**, not in the simulator. If
  the simulator owns randomisation, move it there and keep the emitted `Variant`
  faithful to what was actually applied, the UI correlates failures against it.
- **Exceptions from a rollout are recorded as a `timeout` failure at `failAt` 1.0.**
  That is a fallback, not a real classification. Return a real failure mode where you
  can.
- **No rate limiting and no run cancellation.** `POST /runs` is guarded by a bearer token
  but nothing caps how many runs one caller may start.
- **Reads are unauthenticated.** `GET /environments` and `GET /runs/{run_id}` are open,
  which is fine while they return scaffold data. Guard them the same way once they do not.

## Timing contract, worth reading before you change anything

`startOffsetMs` and `durationMs` are both relative to the start of the run, in
milliseconds. The client polls once per second and animates the arm between polls by
replaying the episode against those two numbers, so they must describe the real
episode, not container lifetime.

`failMode` and `failAt` must be published as soon as the failure is detected
mid-episode, not only at completion. `report(fail_mode, fail_at)` inside
`run_rollout` does this. If a doomed rollout stays clean until it finishes, the grid
animates it as a success and then snaps on the next poll.

## Authentication

`POST /runs` spawns GPU containers, so it is guarded and fails closed: with no token
configured it refuses rather than running unauthenticated.

```bash
# 1. Create the secret. Use a long random value.
modal secret create forkbench-api-token FORKBENCH_API_TOKEN=$(openssl rand -hex 32)
```

2. Attach it to the `api` function in `app.py`:

```python
@app.function(secrets=[modal.Secret.from_name("forkbench-api-token")])
@modal.asgi_app()
def api() -> FastAPI:
    return web_app
```

3. Put the same value in the repo root `.env` as `API_TOKEN`. The Next.js proxy attaches
   it server side, so it never reaches the browser.
