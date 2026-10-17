# FAULTLINE Pick

**CI/CD for physical AI: turn real-world failures into regression tests.**

Laptop RGB camera → selected unmarked objects → warehouse twin → policy adapter → validated simulated action → independent evaluator → saved case → fresh paired execution and release gate.

The Lab offers three complementary views: **Camera workcell** captures the physical failure; **Warehouse demo** expands procedural kinematic test coverage; **RoboSim physics** runs the original I2RT YAM model through actual native simulated contacts, grasp, lift and release. Robot and policy choices stay separate. RGB supplies estimated positions and assumed geometry; it does not automatically reconstruct the native physics scene. No invented benchmark outcomes or model traces are used in the live Lab. No physical robot is controlled.

## Run locally

```bash
pnpm install
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
# backend/.env already exists locally; otherwise:
cp -n backend/.env.example backend/.env
pnpm dev:full
```

Open **[FAULTLINE Live Lab](http://localhost:3300/lab)**. Backend: `127.0.0.1:8787`, with [OpenAPI](http://127.0.0.1:8787/docs). The services can also run separately:

```bash
.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8787
pnpm dev
```

On this machine, if Corepack cannot write its cache, prefix pnpm commands with `COREPACK_HOME=/private/tmp/faultline-corepack`.

## First live regression

1. Put three contrasting unmarked objects on a table. Mount the laptop/Continuity Camera above them and keep it still.
2. Connect in `/lab`. Select workspace corners clockwise from the top left. Leave coordinates normalized or enter both measured side lengths in metres.
3. Drag a box around each object and assign identities. Geometry is an editable assumption, not depth measurement. Choose a target such as `chocolate_A`.
4. Start `scripted_open_loop` at a slow action pace. **Move the physical target after approach and before grasp.** Inspect the actual `TARGET_DISPLACED` or uncertainty event.
5. Review the recorded disturbance boundaries and confirm **Create Regression Test**. The immutable manifest contains the initial state, source frame references and scheduled movements.
6. Run a fresh paired comparison with `scripted_reobserve` on the same saved case. The candidate receives no future schedule. The independent evaluator verifies correct-item release and full destination containment.

Trace playback and fresh rerun are separate controls. While a saved case reruns, webcam updates cannot alter its environment. Explicitly injected virtual disturbances are labelled `operator_defined`, separate from physical movements.

## Larger warehouse and robot adapters

In `/lab`, select the warehouse workcell and **Load warehouse** to preview a declared 4 × 3 metre layout with 16 parcels, perimeter racks, pallets and scenario-specific obstructions. A preview saves definitions and renders initial state; it does not execute a policy or count as a completed test. Choose a saved warehouse case and run it explicitly. `scripted_obstacle_aware` searches deterministic waypoint routes using only permitted observations and the public robot geometry; the executor independently checks the resulting joint trajectory.

Robot profiles come from `backend/robots.py`: `industrial_6r` is the main generic arm, `compact_6r` uses shorter implemented geometry, and `cartesian` preserves the original demonstration gripper. Profiles are independent of scripted or frontier policy adapters. Six-joint profiles require measured metric calibration for a new camera trial. Their link lengths are declared engineering assumptions scaled from the workcell, rather than measurements inferred from RGB. Choosing another robot creates a new experiment; a saved scenario keeps its original robot configuration and hash.

The 3D renderer draws articulated links from backend FK positions, with real scenario colliders available as an overlay. Orbit/pan/zoom, overview/robot/target/top views and optional cinematic camera motion change presentation only. They do not change actions, state, collisions or results. Reduced-motion preferences disable automatic camera motion.

## Native RoboSim contact physics

```bash
bash scripts/setup_robosim.sh
.venv/bin/python scripts/smoke_robosim.py --count 2
```

Select **RoboSim physics** in `/lab`, choose the native displacement scenario, and explicitly run a policy. The pinned RoboSim Studio core runs Newton/MuJoCo on CPU in an isolated `.venv-robosim`; the browser draws original YAM meshes at measured native poses. The active right arm and its gripper execute real simulated dynamics; the second arm remains idle. Grasp verification uses bilateral contact and measured object lift, without attachment constraints. Release and placement are independently checked from actual final state. Original kinematic/camera executors remain available without this optional installation.

The native regression has actual baseline FAIL and assisted frontier PASS results for Sol, Astra and Opus. These small procedural checks do not establish hardware reliability or Jev's causal advantage over an unassisted frontier model. Full setup, licences, exact evidence references and limitations are in [RoboSim integration](docs/ROBOSIM.md).

## Frontier policies

Add keys to **`backend/.env`**, ignored by git. Never put keys in frontend variables or commit them.

- `gpt-6.1-sol` and `gpt-6-astra`: OpenAI Responses API, typed JSON actions, low reasoning effort.
- `claude-opus-5-5`: Anthropic Messages API, JSON schema via `output_config.format`, low effort, no disabled thinking or forced tool choice.
- `jev_gpt-6.1-sol`, `jev_gpt-6-astra`, `jev_claude-opus-5-5`: actual Jev 1.14 typed feedback before each frontier decision. Jev receives only current permitted observations and feedback; its advice reaches the frontier prompt. The frontier chooses actions, and the executor/evaluator retain authority. Both providers' calls and exact responses are recorded.

Missing keys prevent launch; API failures produce UNKNOWN/TIMEOUT evidence. There is no silent scripted fallback. Traces retain policy IDs, prompt hashes, configuration, actual response model/ID, token usage, observations, returned actions and measured inference latency. Policy-provider calls send symbolic observations and action history, not camera image bytes.

Camera frames are stored locally by default. Explicit post-run Jev diagnosis and experimental grounding can send an approved saved log and inspected tabletop-only crop to TypeSafe. Their two original calls are recorded in `data/jev-verification.json`; the red parcel box was withheld at confidence 0.44, below the local 0.6 suggestion threshold. Grounding suggestions require operator confirmation. Assisted manipulation policies separately send symbolic observations and action feedback; they send no camera image bytes. All Jev output remains advisory and cannot set the independent oracle's result. See [Jev evidence and data boundaries](docs/JEV.md).

## Verify and execute

```bash
pnpm typecheck
pnpm test
pnpm fixtures:validate
pnpm backend:test
pnpm smoke
pnpm benchmark --count 10
# Twelve larger six-joint warehouse cases, each run against both policies:
.venv/bin/python scripts/run_benchmark.py --count 0 --warehouse-count 12 \
  --baseline scripted_open_loop --candidate scripted_obstacle_aware \
  --minimum-cases 4 --completion-threshold 0.8 --fail-on-gate
# Fresh pair on a saved physical case:
.venv/bin/python scripts/run_benchmark.py --count 0 \
  --scenario data/scenarios/CAPTURE-YOUR_CASE_ID.json \
  --baseline scripted_open_loop --candidate gpt-6.1-sol \
  --minimum-cases 1 --completion-threshold 1
```

The default benchmark still executes 10 legacy cases × 2 controllers; `--warehouse-count` defaults to zero. Legacy generated cases, warehouse cases and repeated `--scenario` manifests share a 1–100 total-case limit. Use `--count 0` for warehouse-only runs. Generated definitions are not completed results. Gates return `PASS`, `BLOCK` or `INSUFFICIENT_EVIDENCE`; any forbidden violation or individual regression blocks release. Escalation is not task completion. The warehouse includes deliberately blocked picks, so its 80% completion gate can correctly return BLOCK; `--fail-on-gate` then exits 2. Different capture and controller sources are counted explicitly.

## Evidence and architecture

- `backend/models.py` and `contracts/faultline.schema.json`: shared wire contract; regenerate with `pnpm contracts`.
- `backend/engine.py`: deterministic executor, authority rules, swept proxy collisions.
- `backend/kinematics.py`, `backend/robots.py`: six-axis FK/IK, joint trajectories, link collision validation and policy-independent robot profiles.
- `backend/warehouse.py`: separate opt-in metric warehouse definitions; existing captured manifests stay unchanged.
- `backend/oracle.py`: independent goal verification and paired release gate.
- `backend/capture.py`: selected-object appearance tracking and four-corner homography.
- `backend/policies.py`: interchangeable scripted/frontier adapters.
- `backend/runtime.py`, `backend/app.py`: state bus and authenticated camera/API transports.
- `src/app/lab/`, `src/components/faultline/`: live capture, shared-state renderer and evidence controls.
- `data/scenarios/`: immutable cases. `data/episodes/<id>/`: original manifest, append-only `trace.jsonl`, result, final world and disturbances. `data/frames/`: local source JPEGs. Data is ignored by git; back it up separately for submission.

Read [architecture and event contracts](docs/FAULTLINE_ARCHITECTURE.md), [verified integration notes](docs/INTEGRATIONS.md), and the [one-minute demo/submission guide](docs/DEMO.md). Authoritative specs are in [faultline_final](faultline_final/README_FIRST.md).

Tracking assumes a fixed camera and distinct appearances. Rotation, occlusion and similar objects may require reselection; uncertainty is surfaced. No LiDAR measurements, grasp forces, real robot trials, cloud executions or frontier runs are claimed without actual evidence.

## Optional enhancements and legacy preview

`modal/faultline.py` is an optional bounded CPU runner for the same engine. LiDAR requires a native ARKit bridge. Jev's verified typed diagnosis and experimental crop grounding remain optional; Hyper3D assets remain researched stretch work. None is required for the local loop.

The original teammate frontend at `/` and `/runs/*` remains a **synthetic preview**. Its generated outcomes and scripted animations are separate from FAULTLINE execution evidence. Original documentation is in [legacy frontend notes](docs/LEGACY_FRONTEND.md) and [legacy API](docs/API.md). `modal/app.py` is legacy scaffolding, not the judged executor.

**Deadline: 16:00 Europe/London, 17 October 2026. Stop enhancements by 15:15; reserve the final 45 minutes for a local video, preview, submission and recovery.**
