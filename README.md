# Forkbench

A CI/CD-style evaluation bench for robot manipulation policies. You drop an environment and a task into the dashboard, Forkbench fans the policy out across a batch of randomised simulations, animates every rollout live on one screen, and gates the merge on the aggregate pass rate the way CI gates a build.

This repository is the frontend. The execution backend runs on Modal and is being built in parallel, so the frontend ships with a complete deterministic fallback and demos end to end before the backend exists.

## Quick start

```bash
pnpm install
pnpm dev
```

The dev server listens on port 3300.

This machine's zsh lazy-loads nvm through shell functions that do not survive a non-interactive shell. If `pnpm` fails with `command not found: _load_nvm`, invoke Node 22 directly instead of going through the shell wrapper.

Three routes to look at:

- `/` the drop screen: pick an environment, type a task, choose a fan-out, start a run.
- `/runs/run-demo` a run that clears the gate.
- `/runs/run-regression` a run that fails the gate.

Copy `.env.example` to `.env.local` if you want to change the data mode. The default needs no configuration.

## How it works

### The DATA_MODE seam

Every component fetches `/api/<path>`. One route handler, `src/app/api/[...path]/route.ts`, decides where those bytes come from:

- `DATA_MODE=fixture` (the default) serves the local fixture engine.
- `DATA_MODE=live` proxies to `API_URL`, the Modal web endpoint.

The decision lives in that one file and nowhere in component code. That is the point: the frontend is never blocked on the backend, and switching to the real executor is an environment variable, not a refactor. The shapes on both sides of the seam come from one place, `src/lib/contract.ts`, which the proxy, the typed client in `src/lib/client.ts`, and the fixture validator all read.

### The replay model

The backend does not stream frames. For each rollout it supplies a script: a start offset, a duration, an outcome, and, if the rollout fails, a failure mode and the progress point where it goes wrong. The client renders the motion from that script.

`src/lib/sim/arm.ts` is a planar 2-link arm solved with closed-form inverse kinematics, driven through a scripted pick-and-place. The pose is a pure function of `(sim, progress)`, so a cell can be drawn at any frame without holding state, a run can be scrubbed, and the motion is byte-identical on every replay. `src/lib/replay.ts` maps the run clock onto each rollout's own window and decides what a cell should show right now. It consults the backend's reported status only once the clock says the episode is over, because that is the first moment a verdict means anything.

The result looks live, stays deterministic, and behaves identically against committed fixtures or against Modal.

### Why the grid can run a hundred animated cells

`src/app/runs/[id]/SimGrid.tsx` treats the cost model as the design. A React render per cell per frame is not affordable, so the DOM is built once and never updated: each cell is a static button wrapping a static canvas. A single `requestAnimationFrame` loop walks the array and repaints only the cells that moved, meaning the rollouts actually running, plus any cell whose state just changed and any cell still inside its settle flash. With a bounded worker pool only part of the grid is in flight at once, so most frames repaint a fraction of the cells.

### The gate

`src/lib/score.ts` holds the one real policy decision in the app. Two checks, both computed over settled rollouts only:

1. **Floor.** The lower bound of the 90% Wilson interval on the pass rate must clear `gate.threshold`.
2. **Regression.** The pass rate must not sit more than `gate.regressionTolerancePp` percentage points below the baseline run on the default branch.

The floor check uses the lower bound rather than the point estimate so a run cannot go green on noise: the point estimate answers "what did we measure", the lower bound answers "what do we know is true", and a merge gate should only pass on the second. The interval is Wilson rather than the normal approximation because it stays inside [0, 1] and behaves at the small sample sizes you have while a run is still filling up.

The gate only decides once every rollout in the fan-out has settled. Until then it reports
pending, and the figures on screen are the running numbers, not a verdict. There is one exception:
if the floor has become unreachable, meaning even a pass on every outstanding rollout would leave
the lower bound short, the gate fails immediately rather than spending the remaining compute.

## The fallback engine

`src/lib/sim/generate.ts` builds a complete, plausible eval from a single seed. This is synthetic data. It is a stand-in for real rollouts until the Modal backend lands, and it is clearly labelled as such here so nobody mistakes a fixture for a measurement.

What makes it useful rather than decorative is that failure is **caused** by the domain randomisation rather than drawn at random. Each rollout draws a variant: lighting, friction, object offset, distractor count, camera jitter. `difficultyOf` turns that variant into a single hardness number, and the probability of failure scales with it. `failModeFor` then picks how the rollout breaks from the same variant, so heavy clutter produces collisions, low friction produces grasp slips and drops, and bad localisation or camera jitter produces missed approaches. Each failure mode also has its own window in the episode: a collision happens on approach, a drop happens near the bin.

That causal link is what makes the breakdown panels worth reading. When the pass rate by clutter bucket drops off at five or more distractors, that is a property of the simulated policy, not an artefact of the RNG. If failures were drawn independently of the variant, every breakdown panel would be flat noise and the whole analysis surface would be theatre.

Two details keep it honest. Difficulty is a sum of five roughly uniform terms, so it clusters tightly around its mean; the generator rescales across the fan-out's own spread so that a hard rollout is genuinely likelier to fail. And rollouts are scheduled onto a bounded worker pool with per-worker cold starts, so the fan-out lands in waves and the grid has a real queue to drain.

`freeze(run, atMs)` rewinds a finished run to a point in time so a fixture can show a fan-out mid-flight. Unsettled rollouts lose their outcome: the UI must never know how a running episode ends.

## Project layout

```
src/lib/
  contract.ts        Zod schemas and the endpoint registry. One source of truth for the proxy,
                     the client, and the fixture validator. Frozen for the backend.
  client.ts          Typed fetch. Parses every response against the contract.
  score.ts           Wilson intervals, the two-check gate, failure breakdown, variant buckets.
  replay.ts          Run clock to cell state. The replay model lives here.
  rng.ts             Seeded mulberry32 and weighted picks.
  useEndpoint.ts     Polling hook over the typed client.
  useRunClock.ts     The client-side run clock the grid animates against.
  server/store.ts    Fixture-mode run storage. In-memory runs, committed fixtures, then
                     deterministic regeneration so a shared link never 404s.
  sim/
    environments.ts  The four environments offered on the drop screen.
    arm.ts           2-link IK arm, scripted pick-and-place, five failure modes.
    generate.ts      The fallback engine. Causal failure from domain randomisation.
    draw.ts          Canvas rendering for a single cell.

src/app/
  page.tsx           The drop screen.
  runs/[id]/         The run dashboard: RunHeader, Sidebar and AgentLog, Aggregate, SimGrid,
                     Verdict, Breakdown, SimDrawer. stage.ts narrates which step the run is on.
  api/[...path]/     The DATA_MODE seam.

src/components/      Shared UI, the logo, and the standalone sim canvas.

fixtures/
  runs.json          run-demo, run-live, run-regression.
  environments.json  The environment catalogue.
  run-created.json   The create-run response.
  build.ts           Regenerates the fixtures from the generator.
  validate.ts        Parses every fixture with the schema the frontend parses it with, and
                     asserts the fixtures cover the states the UI must render.

docs/
  API.md             The backend contract. See below.
```

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server on port 3300. |
| `pnpm build` | Production build. |
| `pnpm start` | Serves the production build on port 3300. |
| `pnpm typecheck` | `tsc --noEmit` over the whole project. |
| `pnpm test` | Node's built-in test runner over every `src/**/*.test.ts`, discovered by glob so a new test file cannot be silently left out. |
| `pnpm check` | `typecheck`, then `test`, then `fixtures:validate`. The gate to run before pushing. |
| `pnpm fixtures:validate` | Parses every fixture against the contract and asserts coverage: a green gate, a red gate, a run in flight, and every failure mode reachable. |
| `pnpm fixtures:build` | Regenerates `fixtures/*.json` from the generator. Run it whenever the contract or the generator changes, then commit the output. |

## Backend handoff

The backend contract is written up in `docs/API.md`. Three endpoints, all defined in `src/lib/contract.ts` and all exercised by the fixture validator: `GET /environments` returns the environment catalogue, `POST /runs` accepts an environment id, a task string, and a fan-out and returns a run id, and `GET /runs/:id` returns the full run including every rollout's script. The schemas are frozen for the backend, so additions should be optional fields only. The one behaviour that is easy to miss: `failMode` and `failAt` must be reported as soon as the harness knows them, mid-episode rather than only at completion, otherwise a doomed rollout animates as a clean success and then snaps on the next poll.
