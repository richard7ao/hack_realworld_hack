# FAULTLINE Pick: executable contracts and ownership

The three documents in `faultline_final/` are authoritative. The existing Next.js app is retained; its legacy `/runs` fixture experience is explicitly a synthetic preview. The judged workflow is `/lab`, backed by `backend.app` on port 8787. No Modal, depth sensor, or model credential is needed to run the scripted loop.

## One state bus, three domains

`backend/models.py` is the wire-contract source. `scripts/export_contracts.py` exports its JSON Schema to `contracts/faultline.schema.json`. The live TypeScript client uses corresponding types in `src/lib/faultline.ts`; it never imports the synthetic rollout contract.

1. `ObservedScene`: selected-object RGB estimates with camera sequence, capture time, confidence, visibility, calibration and provenance. No physical mass/friction inference.
2. `SimWorld`: executor-owned virtual objects, robot and destination. Camera updates may move visible, confidently tracked, unheld objects. Held/released virtual objects stay simulator-owned until reset. Conflicts emit events.
3. `PolicyObservation` / policy belief: an explicitly sampled, potentially stale estimate. `OBSERVE` refreshes estimates; action results update robot feedback without secretly revealing current target positions. No oracle, outcome or future schedule reaches a policy.

`position` and `dimensions` use the declared `coordinate_frame`: `workcell_normalized` until the operator enters measured width AND depth, then `workcell_m`. Fields intentionally omit a misleading `_m` suffix in normalized mode. The browser view uses the same backend world, never a separate success animation.

## Execution

`Environment.reset(scenario, seed)` creates a fresh world; `step(PolicyAction)` validates reach, visibility, pose age, grasp distance, swept obstacle intersections, held-object authority and destination containment. It returns bounded policy observation, execution status, termination/truncation and score. The independent oracle reads world + trace and checks target identity, release, full footprint containment and forbidden violations; a model's DONE cannot assert success.

Policies implement `reset(task, capabilities, version)` and async `predict(observation) -> PolicyAction`. Scripted open-loop and reobserving controllers, plus an optional server-key frontier planner, share the same action space and observation permissions. Every inference records input, typed output, wall latency, policy version and prompt hash. Remote API errors remain UNKNOWN/TIMEOUT; there is no silent scripted fallback under a frontier label.

## Robot adapters and six-joint kinematics

Robot selection and policy selection are independent. `backend/robots.py` provides a `RobotAdapter` protocol, `robot_catalog()` and `robot_config_for(profile_id, workspace, coordinate_frame)`. Implemented profiles are `cartesian`, `industrial_6r` and `compact_6r`. The two generic six-joint profiles share the actual kinematic solver with different declared geometry; they are not certified models of branded hardware. Their link lengths, collision radii and home poses are explicit assumptions scaled in metres from the workspace. They require `workcell_m`; normalized RGB cannot silently become metric geometry.

The opt-in configuration is stored in `Scenario.provenance.robot_config`. Scenario and ObservedScene gained no serialized default fields, preserving existing captured manifest hashes. Robot selection affects new camera captures or newly generated workcells. Rerunning a saved manifest never replaces its robot configuration.

`backend/kinematics.py` implements a chain of six revolute joints: base yaw, shoulder pitch, elbow pitch and three intersecting wrist axes. Analytic IK evaluates two elbow branches for a tool pose; FK yields the tool transform and link origins. Successful motion logs IK residuals, joint limits and interpolated joint paths. Each interpolation interval uses a conservative displacement bound to inflate link capsules against declared axis-aligned obstacles; carried proxy-box volume is also checked. Unreachable goals, limit violations and arm collisions reject the action before robot state changes. This is rigid-chain kinematics with declared collision geometry, without contact dynamics, self-collision, torque limits or hardware execution. See the [Modern Robotics FK/IK reference](https://modernrobotics.northwestern.edu/chapters/chapter6/) for the distinction between task poses and joint solutions.

`Robot` carries `kinematics_kind`, `joint_angles` in radians, `joint_limits`, seven `link_positions` and `tool_rotation`, in addition to its Cartesian tool pose and gripper state. The three wrist axes share a joint centre, so their link-origin positions coincide. `MOVE_TO.orientation_rpy` is an optional backend action field; ordinary symbolic policies can use the default fixed tool orientation.

`scripted_obstacle_aware` searches a bounded set of waypoint routes using only the sampled observation, observed obstacles and public robot capabilities. It does not receive future disturbances or hidden world state. It may request help when its bounded search finds no route; this is not a completeness claim or task success.

## Warehouse and presentation

`warehouse_cases(count=10, seed=42017)` is a separate opt-in generator, available from `backend.warehouse` and `backend.generator`. It creates a 4 × 3 metre PROCEDURAL workcell with 16 declared parcels, perimeter racks/pallets, the generic industrial 6R arm and four families: clear aisle, route obstruction, target displacement and a deliberately blocked pick. The original `generate_cases()` defaults remain unchanged.

The Three.js/React Three Fiber renderer consumes backend object positions and actual FK link positions. Industrial skins, camera views, shadows and cinematic framing are presentation; declared proxy geometry controls collision tests. Overview, robot, target and top shots coexist with orbit/pan/zoom and a collider overlay. Reduced-motion preferences suppress automatic camera movement. Preview, recorded playback and fresh execution remain distinct states.

Workcell APIs require the camera-session bearer token:

- `POST /api/workcells/warehouse`: `{session_id,count,seed,robot_id}` creates 1–20 warehouse definitions and previews the first; returns `executed:false`.
- `POST /api/workcells/scenario`: `{session_id,case_id}` previews an immutable saved definition without inference.
- `POST /api/workcells/camera`: `{session_id}` returns to the existing camera calibration/tracking workcell.
- `POST /api/policy/run`: accepts `robot_id` for a new camera capture; a supplied saved case retains its configuration.
- `POST /api/benchmarks/run`: accepts `warehouse_count` alongside saved IDs and legacy `generated_count`, with at most 100 distinct combined cases.
- `GET /api/health`: reports implemented robot profiles independently of available policies.

The CLI adds `--warehouse-count` (default 0); use `--count 0 --warehouse-count 12 --candidate scripted_obstacle_aware` for warehouse-only paired execution. All CLI case sources together must contain 1–100 distinct cases.

Actions: `OBSERVE`, `MOVE_TO`, `GRASP`, `PLACE`, `WAIT`, `REQUEST_HELP`, `DONE`. Disturbances execute after a **one-based completed-action count**, including OBSERVE/WAIT. Replays use that exact boundary, never wall time. Live camera transitions record absolute before/after changes; operator confirmation compiles them into scheduled manifest events.

## Durable evidence

Local `data/` stores frames, immutable scenario manifests, episode JSON and append-only JSONL events. Durable episode events have schema version, monotonic per-episode sequence, wall timestamp, simulation time, session and episode identity; mixed live messages also carry a session-monotonic `bus_seq`. Scenario hashes cover the canonical manifest. Reruns create new episode IDs and environments; trace playback performs no inference. Comparison requires paired case hashes and policy manifests. Zero forbidden violations, no new critical regressions, configured completion threshold and minimum evidence determine PASS/BLOCK/INSUFFICIENT_EVIDENCE. Appropriate help remains ESCALATED, rather than PASS.

Camera sessions use expiring random bearer tokens. JPEG binary ingest is bounded, serial per camera, drops stale sequences, and returns tracking estimates. WebSocket messages publish state/events; REST polling is a fallback. Raw camera frames stay local by default, and frontier policy APIs receive only symbolic observations/action history. Explicit Jev operations are an exception: a specifically approved saved log and inspected tabletop-only crop were sent to TypeSafe. The two actual `jev-1.14.0` responses, crop hashes, exact scope and advisory outcomes are in `data/jev-verification.json`; the red box was withheld at 0.44 confidence. No Jev result automatically updates the tracker or oracle. Explicitly labelled procedural simulations, live captures, and frontier simulations are counted separately.

## Modules

- `backend/models.py`: shared validation and versioned contracts.
- `backend/capture.py`: four-corner homography, selected-object appearance tracking, uncertainty.
- `backend/engine.py`: deterministic virtual workcell and action validation.
- `backend/kinematics.py`: actual six-revolute-joint FK/IK, joint paths and conservative link/held-box obstacle checks.
- `backend/robots.py`: implemented generic robot registry, separate from policies.
- `backend/warehouse.py`: metric procedural warehouse scenarios.
- `backend/policies.py`: interchangeable adapters and frontier transport.
- `backend/oracle.py`: independent goal verification and paired release gates.
- `backend/storage.py`: atomic manifests/results and append-only traces.
- `backend/runtime.py`: live sessions, policy execution, scenario capture, benchmark orchestration.
- `backend/app.py`: authenticated camera/API/WebSocket transport.
- `backend/jev.py`: opt-in advisory diagnosis and experimental crop grounding, separate from the oracle.
- `src/app/lab/`: thin capture, world and evidence controls; existing frontend files remain available.
- `scripts/`: startup, headless smoke, schema export, benchmark, recording helpers.

## Events

`camera.frame_meta`, `observed.scene`, `sim.state`, `policy.observation`, `policy.decision`, `policy.action_proposed`, `executor.action_result`, `robot.kinematics_checked`, `disturbance.detected`, `authority.conflict`, `scenario.created`, `benchmark.case_started`, `benchmark.case_finished`, `policy.timeout`, `policy.error`, `diagnostic.completed`, `gate.updated`.

## Time budget

Stop enhancements by **15:15 Europe/London**. Reserve 15:15–15:35 for a real local 60-second recording, 15:35–15:50 for repository/submission, and 10 minutes of recovery before the **16:00** deadline. A real 10-case execution outranks an unexecuted 100-case grid.
