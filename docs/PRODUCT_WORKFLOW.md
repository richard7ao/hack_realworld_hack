# FAULTLINE operating model

FAULTLINE is a robotics policy regression and release-check product. Its evidence loop is capture → immutable scenario → fresh policy execution → independent result → paired release gate. Rich scenes explain outcomes; they cannot set them.

## Product surfaces

- **Workspace**: configure camera capture, a 4 × 3 m warehouse, or native RoboSim contact physics; execute one policy; inspect current decisions and errors. Setup, recorded playback and fresh execution remain distinct.
- **Regression tests**: inspect saved initial scenes, measured disturbances, provenance and hashes; preserve a physical failure; start a fresh candidate execution.
- **Release checks**: compare baseline/candidate on identical immutable scenarios, using local parallel workers or supported Modal workers; inspect fixes, regressions, violations and gate thresholds.
- **Production line**: four native fixture-transfer stages using RoboSim/YAM contact physics, or a lighter electronic kitting workflow using kinematics. Native stages explicitly re-index the part in a fixture and reset arm/orientation/velocity; prior actual poses remain recorded. Kinematic stages carry object positions and reset the arm. The operator can queue a component relocation or tray reroute for the next frozen stage. Each stage receives its own oracle result; partial failures remain failures.
- **Parallel runs**: run 50 or 100 procedural case pairs, producing 100 or 200 actual episodes, across a bounded pool of up to four Modal CPU containers. Client requests in flight and timestamp-measured worker overlap are distinct.

## Environment definitions

The machine-readable catalog is `GET /api/environments`. Camera uses RGB planar pose estimates with declared heights. Warehouse uses rigid-link kinematics and collision proxies. RoboSim uses the original YAM native body model and MuJoCo contact solver on CPU. Native production uses the RoboSim contact executor; the optional electronic kitting mode uses warehouse kinematics. Neither mode claims automated defect inspection or real hardware execution.

## Controller and evaluator roles

GPT 6.1 Sol, GPT 6 Astra and Claude Opus 5.5 are real policy adapters. Jev-assisted variants obtain typed advice before each frontier decision. The frontier returns a typed symbolic action; the executor validates and executes it; the independent oracle checks the released object and constraints. Provider requests, responses, errors, calls and inference time are saved. Modal currently supports the three scripted kinematic controllers; cloud provider keys are not mounted.

## Reconstruction

Hyper3D reconstruction is explicitly started from one selected camera crop. Returned GLBs are local visual assets matched by original camera session and object ID. Known footprint inputs constrain visual scale; height remains declared. A normalized workspace does not become metrically calibrated just because an object footprint is known. Mesh appearance cannot modify frozen manifests, colliders or result evaluation.

## Final iteration acceptance

Preserve the executable capture loop, actual API calls and evidence. Check desktop/mobile composition once, apply material fixes together, confirm once, then freeze. Keep the original verified one-minute recording available while preparing the final take. Source may be shared on GitHub; credentials, captured frames, logs and recordings stay local unless deliberately packaged.
