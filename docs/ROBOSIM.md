# RoboSim Studio integration

FAULTLINE uses the unchanged RoboSim Studio core at commit `73739abe212f963e8a9f5862b27bca370df091a7`, its I2RT YAM model, Newton 1.6.1 and native MuJoCo 3.12.0 on CPU. The browser renders the original STL vertices at measured native body/geometry poses. These are simulated robot interactions, not a video, a scripted visual animation or physical hardware execution.

The purpose stays the same: preserve a disturbance as an immutable regression, execute another controller in a fresh environment, and independently verify whether the change fixes the failure. A detailed robot view makes the failure understandable; it cannot set the result.

## Set up and run

Start the ordinary Lab following the root README. The original capture and warehouse executors remain usable without the optional physics environment.

```bash
bash scripts/setup_robosim.sh
.venv/bin/python scripts/import_robosim_assets.py --verify
.venv/bin/python scripts/smoke_robosim.py --count 2
```

Setup creates `.venv-robosim`, separate from the main backend virtual environment. The tested runtime is Python 3.12 on Apple Silicon, using native CPU physics. The dependency lock pins the tested packages and both Git dependencies. No CUDA, RTX renderer, Modal deployment, GAP or cuRobo install is required. First-time setup/compilation can take longer than a warm scene load.

In `/lab`, select **RoboSim physics**. Loading prepares a native scene and displays its state; it does not create a completed policy episode. Choose a saved native scenario and explicitly run a policy. **Camera workcell** preserves the separate RGB capture workflow; **Warehouse demo** preserves the larger 4 × 3 m kinematic workcell. Saved cases retain their original executor.

To execute a new comparison with approved symbolic-state API traffic:

```bash
.venv/bin/python scripts/run_benchmark.py --count 0 \
  --scenario data/scenarios/ROBOSIM-displacement-42018.json \
  --baseline scripted_open_loop --candidate jev_gpt-6.1-sol \
  --minimum-cases 1 --completion-threshold 1 --fail-on-gate
```

Generate the native cases first through the UI or smoke command. Add provider credentials only to the ignored `backend/.env`. Substitute `jev_gpt-6-astra` or `jev_claude-opus-5-5` for the other assisted frontier adapters.

## What is implemented

The native scene uses the original `bench_075`: a 0.595 × 1.3 m work surface at world origin `(0.6, 0, 0.75)`. FAULTLINE uses its own corner-origin metric frame. The active right YAM arm has six revolute joints and an actuated two-finger gripper; the second arm retains its native idle pose. Robot configuration, contact geometry and transforms come from the upstream model. The current motion adapter supports the declared downward grasp orientation; unsupported orientation requests fail explicitly.

Actions advance the actual native solver. Grasp checks use bilateral fingertip contact and measured dynamic object lift, with no attachment constraint. Place opens the native fingers, advances and settles physics, then the independent FAULTLINE evaluator checks the actual released object pose and footprint. Full object quaternions are retained for rendering and containment. An unreachable pose, missing grasp, motion timeout or invalid action remains a recorded failure.

Live execution publishes measured body/object/contact snapshots every 100 ms of simulation time and paces the actual control steps. Camera presets and cinematic movement affect only the view. Recorded trace playback shows saved states; fresh rerun creates a new environment, policy decisions and result.

The scene manifest selects `provenance.execution_backend = robosimstudio_cpu`. `backend/robosim.py` dispatches only these cases to an isolated worker process; unavailable native execution raises an explicit error. Provider credentials are removed from that worker's environment. The original captured manifests and their hashes are unchanged.

## Jev and frontier roles

The three `jev_` adapters call `jev-1.14.0` before each frontier decision. Jev receives a compact current policy observation: sampled object estimates, robot feedback, public capabilities and the previous action/error. It returns typed manipulation risk, recommended intent and unsafe-to-repeat advice. The frontier receives that actual guidance in its input and still chooses the symbolic action. Neither provider receives hidden future disturbances or authority over the evaluator. These calls send symbolic state, not camera images.

The controller panel distinguishes selected from executed policies and shows actual calls, measured inference time, latest action, Jev feedback and provider response evidence. Full request/response provenance is saved in `policy.decision` events; failed downstream requests retain completed advice in the error event. Both Jev and frontier attempts count as model calls. Missing keys or guidance failures never silently substitute a scripted controller.

Post-run Jev diagnosis and experimental image grounding remain separate explicit actions. Their saved verification is not evidence of a controller run, and image grounding does not automatically alter tracking.

## Actual local evidence

- `data/benchmarks/bench_robosim_0497daa367cf.json`: four native scripted executions, clean PASS/PASS and displacement FAIL/PASS. Gate PASS across two paired procedural cases.
- `data/robosim-stream-proof.json` and `data/robosim-stream-displacement-proof.json`: 92 and 150 actual native state snapshots respectively, monotonic solver time and independently verified placement.
- `data/benchmarks/bench_cli_9b9bcbd3ee0c.json`: baseline FAIL; Sol + Jev PASS on the same native displacement manifest.
- `data/benchmarks/bench_cli_b18506425709.json`: baseline FAIL; Astra + Jev PASS on that manifest.
- `data/benchmarks/bench_cli_2118c2983e8f.json`: baseline FAIL; Opus + Jev PASS on that manifest.

These are small procedural regression checks. They do not establish hardware reliability, general benchmark superiority or a causal performance advantage from Jev compared with the same frontier model alone. Earlier unsuccessful native trials remain saved, including `bench_robosim_016dee19da7d`; no results were replaced to improve the record. The separate 12-case larger warehouse suite still correctly blocks its 80% gate at 75% completion.

## Source and redistribution

Upstream: https://github.com/robosimstudio/robosimstudio. The core is Apache-2.0; the YAM meshes retain I2RT's MIT licence. Copies of the licences, notices, original MJCF/URDF and full source/asset provenance are under `third_party/robosimstudio`. The import script verifies 198 unchanged Python files and nine unchanged STL files against pinned SHA256 allowlists. White/graphite browser materials are presentation overrides; the mesh vertices and native poses remain unchanged.

Execution logs and camera recordings are local ignored data. Source and assets are shared through GitHub; an evidence bundle is required to transfer a captured regression to another machine.
