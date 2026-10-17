# FAULTLINE integration notes

Checked against official documentation on **17 October 2026**. The three files in `faultline_final/` are the product specification. This file records current API details and the boundary between working local code and optional services.

## Working core and evidence

`backend/models.py` defines scene, action, scenario, event and result contracts; `backend/runner.py` creates a fresh environment and policy per episode. `backend/oracle.py` independently evaluates object release, destination containment and hard violations. Camera estimates, simulator state and sampled policy belief remain separate. The Next app's `/lab` integration uses the local FastAPI service on port 8787. The older frontend fixture dashboard and `modal/app.py` scaffold are not evidence of executed FAULTLINE tests.

Run `.venv/bin/python scripts/smoke_test.py` for four actual scripted executions: clean placement, stale-target rejection, recovery, and a fresh execution loaded from saved JSON. `data/smoke-latest.json` points to the durable report. Run `.venv/bin/python scripts/run_benchmark.py --count 10` for ten paired scenarios/twenty executed episodes. `data/benchmark-latest.json` points to results, gate and episode references. These are procedural symbolic simulations. Camera trials and remote model/cloud calls must be reported separately.

## Robot profiles, warehouse and actual 3D state

`backend/robots.py` is independent of policy adapters. `robot_catalog()` lists three implemented profiles: the legacy `cartesian` gripper, main `industrial_6r` arm and shorter `compact_6r` arm. `robot_config_for(profile_id, workspace, coordinate_frame)` returns the explicit generic geometry or `None` for legacy Cartesian execution. Six-joint profiles require `workcell_m`; link lengths are declared assumptions scaled in metres from the workspace. They are not measured from RGB or certified models of named industrial hardware. Saved scenarios fix this configuration in provenance, so a robot selector cannot silently change an existing regression case.

The six-axis engine performs deterministic analytic IK/FK, checks joint limits and validates interpolated arm-link capsules and held-object proxy volume against declared obstacles. Results include actual joint angles, FK link positions, IK residuals and collision link/sample evidence. There is no contact dynamics, self-collision model, torque simulation, hardware driver or hardware safety claim. `scripted_obstacle_aware` searches bounded waypoint routes from permitted observations and public capabilities; a route-search failure can appropriately escalate without counting as a completed pick. [FK/IK concepts](https://modernrobotics.northwestern.edu/chapters/chapter6/).

The larger generator produces 4 × 3 metre PROCEDURAL scenes with 16 parcels, racks, aisles/pallets and clear, obstructed, displaced-target or deliberately blocked picks. Load them through authenticated `POST /api/workcells/warehouse` with `{session_id,count,seed,robot_id}`; loading returns a preview with `executed:false`. `POST /api/workcells/scenario` previews a saved case, and `/api/workcells/camera` returns to camera tracking. `POST /api/policy/run` accepts a robot profile for a new camera trial; saved reruns retain their manifest. `POST /api/benchmarks/run` accepts `warehouse_count`. `/api/health` exposes robot and policy catalogs separately.

The Three.js workcell uses actual backend FK link positions. Orbit/pan/zoom, overview/robot/target/top presets, collider overlays and optional cinematic framing affect only presentation. They do not move backend objects or change an evaluation. Reduced-motion settings suppress automatic camera movement.

```sh
.venv/bin/python scripts/run_benchmark.py --count 0 --warehouse-count 12 \
  --baseline scripted_open_loop --candidate scripted_obstacle_aware \
  --minimum-cases 4 --completion-threshold 0.8 --fail-on-gate
```

`--warehouse-count` defaults to 0, preserving the old ten-case CLI default. All generated, warehouse and saved definitions together must contain 1–100 cases. The fresh post-fix execution `bench_cli_10647f1df557` completed **24 actual episodes on 12 warehouse cases**: baseline 3 PASS/9 FAIL; candidate 9 PASS/3 ESCALATED with `APPROPRIATE_HELP`, six fixed failures, no regressions and no candidate hard violations. Its gate is correctly **BLOCK** because 75% completion is below the configured 80%; the CLI exited 2 with `--fail-on-gate`. Results and traces are in local `data/benchmarks/bench_cli_10647f1df557.json` and the referenced episode directories. `data/warehouse-benchmark-latest.json` points to that completed record. The earlier `bench_warehouse_8ec11c4f6a17` remains preserved; it predates the blocked-target help classification fix.

## OpenAI: requested frontier models

Use exact API IDs **`gpt-6.1-sol`** and **`gpt-6-astra`**, with server-side `OPENAI_API_KEY`. Both support Responses and structured outputs. Sol's documented reasoning levels are `low`, `medium`, `high`, `xhigh`, `max`; `none` and `minimal` are unsupported. Use low effort initially to keep decision latency manageable. Model availability must be established with the user's account; no silent fallback to an older model. [Sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra).

`backend/policies.py` submits `POST https://api.openai.com/v1/responses` with `model`, `instructions`, the policy-limited observation in `input`, `reasoning.effort`, and `text.format: {type:"json_schema",name:"robot_action",strict:true,schema:...}`. Parse `output` content blocks of type `output_text`, then validate with `PolicyAction`. Persist model/response ID, usage, prompt hash, selected action and measured inference time. Handle refusals, incomplete responses, timeouts and malformed actions as evidence-bearing failures; schema validity cannot establish task success. [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

The adapter is implemented. A model is live-tested only when its episode trace contains an actual provider response; docs verification and mocked transport tests do not establish provider access or task performance.

## Anthropic: Claude Opus 5.5

Use **`claude-opus-5-5`**, `POST https://api.anthropic.com/v1/messages`, `x-api-key`, and `anthropic-version: 2023-06-01`. **Adaptive thinking is always on.** Omit `thinking` or send `{"type":"adaptive"}`. Do not send disabled thinking or a manual thinking budget. Set `output_config.effort` explicitly; the documented default is medium. `max_tokens` includes thinking and response. Forced tool choices `any` and `tool` are rejected: use automatic tool selection with strict schemas, or structured JSON output. FAULTLINE uses `output_config.format` and validates the returned text as an action. [Official Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide).

`ANTHROPIC_API_KEY` belongs only in `backend/.env`; it is never a browser variable. This adapter has the same honest live-test boundary as OpenAI.

## Browser camera, Continuity Camera and recording

The laptop browser receives camera video using `navigator.mediaDevices.getUserMedia`, with audio disabled. A Continuity Camera is an RGB video source when macOS makes it available to the browser; use the camera selector rather than assuming a device index. Secure contexts and browser/OS permission are required. `localhost` qualifies on the laptop; an iPhone viewing `http://<laptop-LAN-IP>` does not gain this exception. Phone use requires trusted HTTPS and matching secure backend transport. [Browser camera reference](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

The core ingest supports authenticated JPEG HTTP frames and metadata-then-binary WebSocket frames. Start around 640×480/5 FPS, drop stale frames, bound queues and keep capture sequence/timestamps increasing. These are operating settings, not measured throughput claims. Select ordinary objects once by bounding box, then follow tracker estimates; reseed after rotation or lost confidence. Avoid switching resolution after calibration.

`MediaRecorder` records a supplied `MediaStream`. Probe candidate MIME types with `MediaRecorder.isTypeSupported`, collect nonempty `dataavailable` chunks, call `stop`, and wait for the final data/stop events before building/downloading the Blob. A camera recording contains that stream, not the whole application. Use local OS screen capture for the judged one-minute recording. [MediaRecorder reference](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder).

## OpenCV tracking and planar calibration

`backend/capture.py` uses manual appearance templates with `cv2.matchTemplate`; textured templates use `TM_CCOEFF_NORMED`, low-texture patches use `TM_SQDIFF_NORMED`. The best location is the maximum for correlation or minimum for squared difference. A low match score hides the object rather than providing fictitious certainty. Matching is sensitive to rotation, scale, similar-looking items, exposure and occlusion; physical QA on the actual scene is still necessary. [OpenCV template matching](https://docs.opencv.org/4.x/d4/dc6/tutorial_py_template_matching.html).

Four ordered, convex workspace corners map onto the plane with `getPerspectiveTransform` and `perspectiveTransform`. Use measured workspace width/depth to claim metres; otherwise `workcell_normalized` remains explicit. A planar homography cannot measure object height or mass, and elevated objects can show parallax. Enter approximate dimensions and retain assumed-field provenance. [OpenCV transform reference](https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html).

## Modal: optional bounded CPU workers

The new `modal/faultline.py` executes the same `backend.runner.run_case` engine in CPU workers with `cpu=1`, `memory=512`, `max_containers=4`, a 180-second timeout and no retries. `worker.starmap(..., return_exceptions=True)` retains failures; each successful worker returns result, complete JSONL trace, scenario and final state. The local entrypoint writes returned evidence to `data/episodes/` and a real paired benchmark/gate to `data/benchmarks/`. It does not call the older GPU scaffold. [Modal function map/starmap](https://modal.com/docs/sdk/py/latest/Function), [scaling limits](https://modal.com/docs/guide/scale).

The image installs only headless policy/contract dependencies and uses `add_local_python_source("backend")`; non-Python secrets are not included. This entrypoint accepts scripted policies only. Frontier cloud execution needs a separately configured Modal Secret and account-specific rate limits. [Modal source packaging](https://modal.com/docs/sdk/py/latest/Image).

Optional setup, after the local demo works:

```sh
.venv/bin/pip install -r backend/requirements-modal.txt
.venv/bin/modal setup
.venv/bin/modal run modal/faultline.py --count 10
```

The adapter is implemented and syntax-checked. Cloud authentication, image build and remote execution are **unverified until that command succeeds and evidence returns**.

## Jev / TypeSafe: verified advisory calls and experimental localization

The official endpoint is `POST https://api.typesafe.ai/v1/systemone`, Bearer authentication, with top-level `model`, `state` and a `questions` map. Choice decisions use `type:"choice"`, instructions and a criteria map; returned `answers.<id>` contains the choice, probabilities and confidence. This can optionally classify an observed failure, but the deterministic evaluator remains authoritative. [TypeSafe API reference](https://docs.typesafe.ai/api).

The adapter pins **`jev-1.14.0`**, the newest release documented on 17 October 2026, available since 14 October. The `jev-preview` alias points at 1.14; `jev-latest` still points at 1.13. Exact response versions are recorded rather than inferring them from an alias. [Official model versions and aliases](https://docs.typesafe.ai/models).

Image localization requires **`jev-preview` or pinned `jev-1.14.0`** and header **`TypeSafe-Danger-Zone-Images: true`**. A Box question is `{type:"box",instructions:"the chocolate bar in `photo`"}` with no criteria. Its answer contains `box:{top,bottom,left,right}` as normalized fractions and confidence. Validate edges, confidence and identity before converting to the scene schema. The vendor explicitly describes images and Box as experimental. [Box reference](https://docs.typesafe.ai/primitives/box).

In JSON, put a unique image reference in `state.photo` and an asset under that reference: `{type:"image",format:"jpg",data_base64:"..."}`. No `data:` prefix. Multipart is preferred: first part `request` contains JSON; the asset references a separate image part. Images must be PNG/JPEG, each dimension 280–1568 px and at most 16 MiB; send upright pixels. [Official image wire format and limits](https://docs.typesafe.ai/images).

Two real, explicitly authorized requests completed on the saved physical case: one typed log triage and one experimental tabletop-crop grounding request. Both actual response models were `jev-1.14.0`. Triage returned `stale_target_pose` with reported probability 0.95; that is an advisory provider output, not measured classification accuracy. Grounding returned red-parcel presence 0.92 with box confidence **0.44**, so the local 0.6 confidence rule correctly withheld the red suggestion. Orange/blue suggestions remain subject to operator confirmation. Neither request changed tracker state or the independent evaluator. Exact payload scope, crop bounds/hashes, responses, token usage and measured latency are in local `data/jev-verification.json`; details are in [Jev implementation and verification](JEV.md).

Frames are local by default and frontier action APIs receive only symbolic state. The Jev image request is an explicit exception: the user approved a saved log and an inspected 500 × 290 tabletop-only crop for the TypeSafe endpoint. No background full-frame upload or continuous Jev tracking is implemented. A crop suggestion is not depth, joint measurement, grasp success or benchmark reliability. Use the local tracker when optional Jev calls fail.

## Hyper3D Rodin: researched optional assets

The current API base is **`https://api.hyper3d.com/api/v2`**. Submit `POST /rodin` with Bearer authentication and multipart fields; the official quickstart uses `images`, `tier=Gen-2.5-Medium`, `mesh_mode=Raw`, `quality=medium`. Preserve two distinct IDs: `jobs.subscription_key` is sent to `POST /status`; top-level `uuid` is sent as `task_uuid` to `POST /download`. Wait at least five seconds before polling, back off/obey Retry-After, stop on Failed and download only after every job is Done. [Official Rodin quickstart](https://docs.hyper3d.ai/en/get-started/quick-start).

This is researched stretch work, with no generation executed. Generated visuals must not replace engineering collider proxies or be presented as measured object geometry.

## Optional native iPhone LiDAR

Use native ARKit `ARWorldTrackingConfiguration`, first checking `supportsFrameSemantics(.sceneDepth)`. The same `ARFrame` supplies `capturedImage`, `sceneDepth`/optional smoothed depth, confidence, camera intrinsics, camera transform and timestamp. Send explicit RGB/depth dimensions, orientation and matrix wire ordering. `sceneDepth` is optional and may be nil; discard low-confidence/invalid samples. [ARFrame sceneDepth](https://developer.apple.com/documentation/arkit/arframe/scenedepth), [ARDepthData](https://developer.apple.com/documentation/arkit/ardepthdata).

Safari RGB capture does not provide this native ARKit bridge. No native device build, depth alignment or physical LiDAR measurement is claimed here. RGB remains the working core path; depth can enrich the same observed-scene fields only after device verification.

## Desk View: verified local path

Apple Desk View was launched with the built-in MacBook camera on this machine. Chrome's normal camera selection continued to show the face camera; Desk View did not automatically replace it. The implemented **Share Desk View window** control uses a direct `getDisplayMedia({video:true,audio:false})` gesture, then sends the selected Desk View window through the same bounded JPEG tracker ingest with `source=desk_view_window_rgb`. A real tabletop feed and three selected parcel identities were verified in the live UI. Keep the Desk View window's framing fixed after calibration. Normal webcam capture remains separate. This is RGB window capture, with no LiDAR/depth claim. [Apple Desk View](https://support.apple.com/en-us/121541).

Actual API verification also completed on one saved **procedural** displacement case for each requested model: `gpt-6.1-sol` (10 calls), `gpt-6-astra` (10 calls), and `claude-opus-5-5` (15 calls). Each produced a separately persisted independently verified simulated placement; these three single-case checks are not a physical reliability benchmark. Evidence references are in the local `data/frontier-verification.json` file.

Separately, saved physical regression `CAPTURE-5e049d873f` reproduced baseline `FAIL / TARGET_DISPLACED` and fresh frontier-candidate PASS results for all three requested models. Those candidate episodes made 11 Sol, 10 Astra and 14 Opus calls, with all 35 actual response IDs and matching requested/response model names recorded. Local `data/physical-frontier-verification.json` retains canonical and isolated-original evidence paths. This is one saved physical scene and one simulated candidate trial per model; it does not establish broad model reliability or real robot grasp success. The physical manifest hash remains `1f36b47976eaa916316d99a4a7ffbf0637962cba56fbd9bc5d0eeffeeb9be0ac`.
