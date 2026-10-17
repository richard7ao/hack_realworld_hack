# FAULTLINE Pick — Final Engineering Build Brief

**Type:** Coding-agent handoff / execution plan  
**Companion:** [Product requirements](FAULTLINE_PRD.md), [iPhone camera & LiDAR guide](CAMERA_LIDAR_INTEGRATION.md)  
**Revision:** 17 October 2026  
**Finish line:** Working local demo and 60–120 second submission recording **before 16:00**.

> **Goal:** From one live physical disturbance to a saved, independently rerunnable robotics regression test with measured policy outcomes. Everything else is subordinate to this loop.

## A. Build rules for every agent

1. **Shared typed schema first.** No isolated mock dashboards that later require rewriting the backend.
2. **One authority for simulator ground truth.** Frontend renders state; it does not decide task success.
3. **Keep truth separate from observation and belief.** Policies must not receive hidden simulator state or future disturbance schedules.
4. **Never pretend a virtual grasp is a real-world robot grasp.** Label the environment accurately.
5. **Camera input must work without markers** or QR codes on items; manually click/select objects initially, then track.
6. **RGB works without LiDAR.** LiDAR is an optional enrichment after the core loop works.
7. **No invented test results.** Every run has a recorded trace and evaluation event, including timeout/unknown.
8. **Run and test incrementally.** First one scenario, then ten; Modal/100 only after local correctness.
9. **Reserve video and integration time.** This build is for a time-limited hackathon and reliability matters.
10. **Agents can modify both frontend and backend**, but coordinate changes through API/schema contracts.

---

## B. What to build today

### P0 components

- **Capture service**: laptop webcam or iPhone Safari RGB feed, selected object tracking and calibration; fallback recorded video.
- **Scene store**: timestamped `ObservedScene`, `SimWorld`, `PolicyBelief` and provenance.
- **2.5D simulator**: simple Cartesian pick-and-place, scene colliders, pickup and drop evaluator, disturbances.
- **Policy adapters**: `ScriptedOpenLoop`, `ScriptedReobserve` (for deterministic validation), `FrontierPlanner` (structured action selection). Versioned configuration.
- **Live 3D UI**: industrial workcell, RGB video overlay, live object pose updates, policy trace.
- **Scenario recorder / rerunner**: persist observed disturbance as scenario manifest; fresh reset and rerun against candidate.
- **CI Bench**: scenario seeds, actual run tiles, comparison table, critical regression gate.

### P1 after P0

- 100 procedural scenarios with Monte Carlo-style variation; use actual test counts.
- Parallel Modal execution if useful and fully integrated.
- Optional Jev visual grounding/classification as a documented experimental adapter.
- Optional LiDAR/native Swift sidecar; optional Hyper3D asset polish.

---

## C. Recommended repository

```text
faultline/
├── README.md
├── .env.example
├── frontend/
│   ├── src/components/{LiveCamera,World3D,RobotTrace,ScenarioGrid,Gate}.tsx
│   ├── src/pages/{LiveLab,Benchmarks,ScenarioDetail}.tsx
│   ├── src/lib/{ws,types,sceneCoordinates}.ts
│   └── ...
├── backend/
│   ├── app.py                     # FastAPI routes and WS
│   ├── models.py                  # Pydantic contracts
│   ├── capture/{frames,tracker,calibration,depth}.py
│   ├── engine/{environment,actions,collisions,oracle}.py
│   ├── policies/{base,scripted,frontier}.py
│   ├── tests/{generator,runner,regression,gates}.py
│   ├── storage/{events,scenarios,runs}.py
│   └── test_engine.py
├── camera_web/                   # HTTPS mobile browser capture page
├── ios_lidar_bridge/             # Optional Swift/ARKit target
├── assets/                       # GLBs, environment textures, simple meshes
├── fixtures/{recorded_camera,scenarios}/
└── scripts/{dev,smoke_test,run_benchmark}.sh
```

Use shared JSON schemas generated into TypeScript/Python if convenient; otherwise enforce explicit Pydantic and TypeScript matching contracts. Create `.env.example`, never commit tokens.

---

## D. Canonical data contracts

### D1. Camera frame notification

Two transport channels are acceptable: (a) binary JPEG frames with immediately adjacent JSON metadata and sequence IDs, or (b) JSON metadata messages and signed `image_ref` fetched from a local frame store. Avoid huge base64 RGB images over JSON for sustained video.

```json
{
  "kind": "camera.frame_meta",
  "camera_session": "cam_001",
  "seq": 123,
  "timestamp_ms": 3504,
  "source": "iphone_web_rgb",
  "rgb": {"width": 640, "height": 480, "encoding": "jpeg", "binary_seq": 123},
  "depth": {"available": false},
  "camera_pose": null
}
```

The optional native bridge uses `source:"iphone_arkit_rgbd"`, `depth.available:true` and carries intrinsics, transform and depth confidence metadata as documented in the camera guide.

### D2. Observed scene (NOT ground truth)

```json
{
  "schema_version": "1.0",
  "kind": "observed.scene",
  "session_id": "s_001",
  "timestamp_ms": 3540,
  "coordinate_frame": "workcell_m",
  "sensor_mode": "RGB",
  "objects": [
    {
      "id": "chocolate_A",
      "class": "parcel",
      "position_m": [0.32, 0.51, 0.02],
      "yaw_rad": 0.1,
      "dimensions_m": [0.14, 0.06, 0.03],
      "visible": true,
      "confidence": 0.84,
      "source": "rgb_tracker",
      "measured_fields": ["x", "y"],
      "assumed_fields": ["height", "mass"]
    }
  ]
}
```

**Important:** If physical length calibration has not been established, use `coordinate_frame:"workcell_normalized"` and coordinates [0..1], not fictitious metres.

### D3. Policy observation envelope

```json
{
  "episode_id": "ep_0042",
  "step": 3,
  "timestamp_ms": 2800,
  "task": {"instruction": "Move chocolate_A to outbound_bin"},
  "camera": {
    "rgb_ref": "frames/ep_0042/003.jpg",
    "frame_id": "camera_0",
    "intrinsics": null,
    "depth_ref": null
  },
  "robot": {
    "end_effector_pose": {"position_m": [0.20,0.18,0.18], "yaw_rad": 0},
    "gripper_state": "open",
    "holding_id": null
  },
  "detected_objects": [
    {"id":"chocolate_A", "x":0.32, "y":0.51, "visible":true, "confidence":0.84}
  ],
  "last_action_result": {"status":"ok"}
}
```

**Rule:** `detected_objects` is a noisy **policy-available estimate**, not a copy of the simulator's guaranteed true positions. Provide policies comparable modalities; document symbolic observations when used.

### D4. Policy action

```json
{
  "policy_id": "frontier_v2",
  "action_id": "a_007",
  "type": "GRASP",
  "target_id": "chocolate_A",
  "target_position_m": [0.32,0.51,0.03],
  "max_execution_ms": 1500
}
```

Minimal action enum: `OBSERVE | MOVE_TO | GRASP | PLACE | WAIT | REQUEST_HELP | DONE`. An accepted action returns an actual executor result; rejected actions have a defined reason (`TARGET_DISPLACED`, `NOT_VISIBLE`, `OBSTRUCTED`, `OUT_OF_REACH`, `INVALID_POSE`, `TIMEOUT`, `ALREADY_HOLDING`, `EMPTY_GRIPPER`). The model must not be asked to assert success.

### D5. Scenario file

```json
{
  "schema_version": "1.0",
  "case_id": "PICK-042",
  "source": "captured_live_rgb",
  "seed": 42017,
  "task": {"target_id":"chocolate_A", "destination_id":"outbound_bin"},
  "initial_scene_ref": "snapshots/case042.json",
  "disturbance": {
    "type": "MOVE_OBJECT",
    "object_id": "chocolate_A",
    "trigger": {"after_action_index": 1},
    "delta_m": [0.14, -0.05, 0.0]
  },
  "limits": {"max_actions": 12, "max_sim_seconds": 30},
  "success_predicate": "correct_item_in_outbound_and_no_forbidden_collision",
  "provenance": {"capture_frame_ref":"frames/live_015.jpg", "observation_confidence":0.86}
}
```

For live capture, infer the disturbance from before/after state **where confidence allows** and let an operator confirm/adjust it before saving. A recorded trajectory isn't automatically a resettable test; convert it into a formal disturbance definition.

### D6. Test result + CI gate

```json
{
  "case_id": "PICK-042",
  "policy_version": "frontier_v2_prompt_c3",
  "outcome": "FAIL",
  "reason": "WRONG_OBJECT",
  "task_success": false,
  "constraint_violations": ["wrong_object_grasp_attempt"],
  "actions": 6,
  "recovery_attempts": 1,
  "sim_elapsed_ms": 5100,
  "wall_elapsed_ms": 12400,
  "trace_ref": "runs/r_42/trace.jsonl",
  "evaluator_version": "oracle_v1"
}
```

Keep `PASS`, `FAIL`, `UNKNOWN`, `TIMEOUT`, `ESCALATED` separately, with rules for when escalation is appropriate. No blanket treating `ESCALATED` as success.

---

## E. Camera connectivity: fastest viable implementation

**Transport topology:** `iPhone Safari (HTTPS) → WSS frame ingest → OpenCV tracker → ObservedScene events → backend simulator → WebSocket → desktop React dashboard`.

### Mobile WebCamera page

- Open an HTTPS capture page on iPhone; show a pairing code or session URL generated from the desktop. The pairing code is on screen and does not require markers on physical objects.
- User taps **Start Camera** granting browser permission; `getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })`.
- Draw video frames into canvas and `canvas.toBlob('image/jpeg', 0.7)` at a modest rate (start with 5 FPS). WebSocket sends metadata (frame sequence + size + time) and binary blobs. Drop stale frames rather than queue indefinitely.
- Backend finds matching camera session, emits `observed.scene` events; UI shows camera status/time since last frame.
- Keep phone awake and on power; use stable high-angle placement. Avoid public camera URLs and keep sensitive surroundings out of shot.

**HTTPS is required for mobile browser camera permission.** A plain `http://<laptop-LAN-IP>` origin may fail. Use a trusted HTTPS deployment/tunnel with WSS, or a native app/USB laptop webcam. Avoid spending time debugging untrusted self-signed certificates during the hack.

### Laptop camera fallback

- `cv2.VideoCapture(0)` → same frame ingestion/track pipeline. It may be harder to mount; if possible use an external webcam or phone as webcam.

### Native ARKit optional

Read [CAMERA_LIDAR_INTEGRATION.md](CAMERA_LIDAR_INTEGRATION.md). Implement a **separate** Swift sidecar, not ARKit in mobile Safari. Broadcast depth-derived metrics through the same `ObservedScene` contract. Fail open to RGB only.

---

## F. Tracking unmarked everyday objects

**Primary pragmatic recipe:** manual initial object box/point selection on a fixed overhead feed, plus simple object tracking and confidence. SAM2 if already installed or quick to run; otherwise foreground difference / HSV mask / nearest-neighbour tracking / click correction. Avoid making a newly announced experimental vision API a mandatory frame-by-frame dependency.

- Initial screenshot from live feed; user creates identities `chocolate_A`, `carton_B`, `highlighter_C`.
- Store centroid, orientation (for rectangular items), rough footprint, appearance descriptor and confidence.
- Track with nearest-previous position + appearance, gate large jumps, allow object to be temporarily `visible:false` rather than teleporting.
- Distinguish **missing target** from **masked target** and **model uncertain**. Under occlusion, update observation uncertainty without secretly providing exact object position to the policy.
- Calibrate workspace 4-corner homography. Measure/reference one physical length if expressing values in metres; otherwise normalized coordinates.
- Assign object height/dimensions manually or from optional LiDAR, always with provenance.
- Highlighter/pen and transparent bottle are stretch tests; first demo use contrastive chocolate bar and opaque carton.

---

## G. 2.5D simulation and evaluation rules

**Do NOT make rendering the physics engine.** Implement `World` in Python with deterministic state updates and a JSON event stream consumed by Three.js.

World: rectangular reachable workcell, objects with simple cuboid/cylinder colliders, gripper with xyz position and opening/held object, destination polygon, obstacles, task and current step.

Actions and checks:

- `MOVE_TO(x,y,z)`: clamp/validate reachable bounds; reject intersection with forbidden obstacle regions for path (simple swept AABB/segment test). Can animate route independently.
- `GRASP(id, pose)`: requires gripper open/empty, target present and graspable under simplified geometry, end-effector close enough to **simulated true pose**, no obstructing collider. Return measured success/failure; never fake physical friction results.
- `PLACE(destination)`: requires holding; move object into destination and evaluate correct-item/zone overlap; release.
- `OBSERVE`: policy receives newly sampled policy observation; no magical peek at hidden truth.
- `REQUEST_HELP`: logged as appropriate or inappropriate based on scenario policy rules; avoid treating unsafe guessing as success.

**Disturbance application:** schedule by explicit simulation step or action boundary, not wall time. Live camera events update unheld objects by configurable authority policy. Support immediate invalidation of previously planned targets; store the exact simulator changes as events.

**State machine:** `IDLE → RUNNING → DISTURBED → (RECOVERING | FAILED | ESCALATED) → (PASSED | FAILED | TIMEOUT)`.

### Faithful replay vs fresh rerun

- **Trace replay:** play saved state/action transitions exactly as recorded, with no fresh policy execution.
- **Scenario rerun:** reconstruct initial state and perturbation sequence, reset policy, allow policy to interact again, evaluate new outcome.
- Label each button accordingly and don't conflate these concepts.

---

## H. Policy adapters, fairness and agent loop

```python
class PolicyAdapter(Protocol):
    policy_id: str
    def reset(self, task: dict, capabilities: dict) -> None: ...
    def predict(self, observation: dict) -> dict: ...

class Environment(Protocol):
    def reset(self, scenario: dict, seed: int) -> dict: ...
    def step(self, action: dict) -> dict: ...

async def evaluate_case(case, adapter):
    env = make_environment()
    observation = env.reset(case, case["seed"])
    adapter.reset(case["task"], env.capabilities())
    trace = []
    for step in range(case["limits"]["max_actions"]):
        action = await adapter.predict(observation)
        result = env.step(validate_action(action))
        trace.append(result.event)
        observation = result.policy_observation  # Not env._ground_truth!
        if result.terminated or result.truncated:
            break
    return independent_oracle(env, case), trace
```

Actual implementation should distinguish synchronous scripted policies from async remote frontier model calls, enforce timeout, retries with limits and structured schema validation. Use server-held API keys. Support policy manifest:

```json
{
  "policy_id": "frontier_closed_loop_v1",
  "adapter_type": "symbolic_tool_agent",
  "model": "provider_specific_model_id",
  "prompt_version": "p3",
  "observation_modalities": ["object_estimates", "last_action_result"],
  "action_space": "symbolic_v1",
  "frame": "workcell_m",
  "max_actions": 12
}
```

**Future policy fidelity:** add adapters for end-effector deltas, joint targets and action chunks; include limits, robot manifest, coordinate frame and rate. A symbolic LLM is not a drop-in equivalent of a low-level VLA.

---

## I. Endpoints and event names

| Endpoint | Responsibility |
|---|---|
| `POST /api/camera/session` | Pair token/session ID + optional phone capture URL |
| `WS /ws/camera/{session}` | Phone frame metadata and JPEG binary (plus optional depth) |
| `WS /ws/live/{session}` | Desktop subscribes to observed and sim events |
| `POST /api/workcell/calibration` | 4 corners + optional metric reference |
| `POST /api/objects/seed` | Initial object selection/identity/footprint |
| `POST /api/scenes/snapshot` | Capture observed scene with provenance |
| `POST /api/policy/run` | Start test execution with policy and task |
| `POST /api/scenarios/from-live` | Turn measured live disturbance into formal saved scenario |
| `GET /api/scenarios/{id}` | Scenario manifest |
| `POST /api/benchmarks/run` | Launch selected cases/policy versions |
| `GET /api/benchmarks/{run_id}` | Actual status/metrics/counts |
| `GET /api/benchmarks/{run_id}/cases/{id}` | Detailed result/trace reference |
| `POST /api/replays/{scenario_id}/rerun` | Fresh execution of saved scenario |
| `POST /api/gates/evaluate` | Deterministic baseline/candidate verdict |

Event types: `camera.frame_meta`, `observed.scene`, `sim.state`, `policy.action_proposed`, `executor.action_result`, `disturbance.detected`, `scenario.created`, `benchmark.case_started`, `benchmark.case_finished`, `policy.timeout`, `gate.updated`. Include `timestamp_ms`, `session_id`, `episode_id`, `seq`, `schema_version` where applicable.

**Transport note:** desktop frontend may subscribe via WS to backend progress. Do not stream every raw depth map to browser if only reconstructed coordinates are needed.

---

## J. Benchmark plan

Case generator: 5 families × 20 generated variants (target moves, occlusion, obstacle insertion, clutter/rotation, destination change). Validate each case is initially feasible or deliberately declared impossible. Each has recorded seed, initial config, action-boundary trigger and perturbation values.

Stages:

1. **3 manually verified sanity cases**: baseline no disturbance, object moved, impossible/occluded case.
2. **10 local scripted runs** to verify simulator/oracle stability and case persistence.
3. **10–20 real frontier-policy runs** as latency/rate limits permit. Include honest `model_id` and number of completed episodes.
4. **100 procedural runs** in parallel if ready; a separate label distinguishes scripted from frontier policy.

For Modal, send case manifests to a CPU worker whose function returns test outcomes/traces. Start bounded concurrency (~8 or lower based on rate limits), and collect failures rather than hiding exceptions. Avoid putting a hot-running 3D renderer on the server; simulation is headless. GPU is not required for custom 2.5D physics.

### Gate example

- Eligible test count >= configured minimum, else `INSUFFICIENT_EVIDENCE`.
- No forbidden collision/wrong-object regressions, else `BLOCK`.
- Candidate completion rate >= policy threshold, else `BLOCK`.
- Show fixed failures and regressions case-by-case even if aggregate rate improves.
- Never report a simulated pass as formal industrial safety validation.

---

## K. Camera / depth / Hyper3D / Jev integration boundaries

- **RGB-only:** functional P0. Small camera feed with tracker, lower computational cost.
- **iPhone LiDAR:** only via native ARKit sidecar. Depth sampled in metres with confidence; combine RGB segmentation masks, intrinsics and camera pose to infer rough object geometry. Full reliable dimensions for small/reflective items not guaranteed. Skip if device/build signing blocks you.
- **Jev:** experimental optional `object bounding box` or classifier; use only if quick and reliable on actual scene images. Not required for object tracking or ground truth.
- **Hyper3D:** generate GLB robot cell/robot arm/conveyor asynchronously. Load with fallback primitive meshes; use simplified proxy collisions from state schema, not mesh geometry.
- **Frontier models:** high-level action decision via structured outputs. Keep calls off the 3D render loop; sample only at decision boundaries.

---

## L. Team integration plan and cut order

### First 20–30 min

1. Agree on `ObservedScene`, `SimWorld`, `Scenario`, `PolicyAction`, `CaseResult` data contracts.
2. Merge stub backend state and 3D visual together early.
3. Start phone stream; if 15 minutes of connection debugging pass, immediately use laptop camera.
4. Have scripted policy run one test end-to-end with an oracle.
5. Launch frontier adapter and native LiDAR/Hyper3D work only in parallel, not as blockers.

### Suggested owner split

- **A (computer vision/camera):** camera handshake, tracking, calibration, optional ARKit with hard timebox.
- **B (backend/agents):** environment, policy contracts, LLM action loop, independent evaluator.
- **C (product/frontend):** 3D world + live state sync + trace/replay UI.
- **D (tests/CI/demo):** scenario compiler, benchmarking/Modal, compare/gate, capture video early.

### Cut order if behind

Hyper3D → ARKit LiDAR → Jev → Modal → scenario count. Keep a working RGB live demo, two controller versions, a saved rerunnable case, and a true CI comparison. When recording, a finished 10-test suite beats a fake 100-test chart.

### Required local smoke test

1. Put unmarked chocolate bar/box/highlighter in frame.
2. Calibrate work zone and assign object IDs.
3. Run baseline controller and physically shift bar mid-execution.
4. Verify backend logs `TARGET_DISPLACED` from action validity, not handcoded UI.
5. Create scenario; inspect saved JSON; rerun under changed policy.
6. Confirm evaluator returns real result, frontend mirrors it, and case appears in CI grid.
7. Disconnect phone and confirm fallback without corrupting a previous run.

---

## M. Submission and video checklist

- Git commit/tag includes source, README, setup, env template and architecture diagram.
- No API tokens in repo; use server-side credentials.
- Real live scene and simulator on screen simultaneously.
- Real policy requests/responses included in recorded trace.
- Saved scenario JSON visible at least briefly.
- Benchmark shows actual completed counts and pass/fail evidence.
- A genuine regression/release gate is shown, ideally with a newly introduced failure.
- Screen recorded locally; separate phone angle records object disturbance; final 60-second video previewed before submission.
- Use accurate sentence: **"We have built a live RGB-to-simulation evaluation pipeline; LiDAR and real robot integration are optional/future depending on completed implementation."**

---

## N. Copy/paste kickoff for coding agent

> You are the lead engineer for FAULTLINE Pick, a time-limited robotics CI/CD hackathon build. Read `FAULTLINE_PRD.md`, `FAULTLINE_BUILD_BRIEF.md`, and `CAMERA_LIDAR_INTEGRATION.md` in full. Start by defining shared typed scene, policy, event, scenario, and test-result contracts. Implement the smallest complete vertical slice: a deterministic 2.5D virtual pick-and-place environment, shared React Three Fiber renderer, camera input with unmarked object selection/tracking, two interchangeable policy adapters (at least one real frontier-model action), a physical disturbance that changes a controller outcome, a saved reproducible regression scenario, a fresh rerun, and a truthful CI gate. Use high-level model actions validated by an independent deterministic executor. Keep observed physical state, simulator truth and policy belief separate. RGB-only must work; optional ARKit LiDAR, Modal, Jev and Hyper3D must never block the core. Persist all genuine run outcomes and traces. Do not use mocked successes in the judged flow. Coordinate backend and frontend changes freely and integrate early. Reserve time for a local 60-second video and complete submission before the deadline.

---

**End of engineering handoff.**
