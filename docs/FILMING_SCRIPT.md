# FAULTLINE rehearsal and filming script

Use the running app at http://localhost:3300. Open separate Chrome tabs for `/lab`, `/robosim`, `/production` and `/parallel`. Provider inference is real and variable; prepare genuine saved evidence before the one-minute recording. Never describe saved playback as a fresh run.

## Rehearse the complete workflow

1. **Capture a physical failure.** Workspace → Camera capture → Share Desk View window (or Switch to Desk View while the webcam is connected). Select the actual Desk View window in Chrome's chooser. Set the workspace again after switching source. Track the unmarked objects. Metric workspace width and depth require measurements; known object footprints alone do not establish the table's metric scale.
2. **Record the disturbance.** Select Scripted · open loop, choose the target, use a four-second action pace and Execute live pick. Pause after approach, slide the physical target without moving the camera, remove your hand, then resume. Read the actual failure; uncertain tracking is a different failure and must not be relabelled.
3. **Preserve the regression.** Regression tests → review measured changes → name it → confirm → Create regression test. Inspect initial scene, disturbance boundary, capture provenance and immutable hash. The existing genuine displacement case is `CAPTURE-5e049d873f`; `CAPTURE-9526adbd43` preserves a separate tracking-loss failure.
4. **Test a policy change.** Use Fresh rerun with GPT 6.1 Sol + Jev feedback, Astra + Jev, or Opus + Jev. Check the new episode ID and actual outcome. Open Policy decisions & controller state, then a Controller decision's full payload. Jev advises before each decision; the frontier returns the action; the executor and independent evaluator determine what happens.
5. **Run native contact physics.** RoboSim → choose the saved displacement case. Execute Scripted · open loop, then execute the same manifest with a guided frontier. The I2RT YAM poses, contacts, lift and released-object checks come from the native CPU solver. Loading a scene alone is not execution.
6. **Run the production workflow.** Production line → Configure a new production batch → Contact physics · RoboSim / YAM → policy → Start production batch. Watch four independently evaluated fixture-transfer stages. Stage two contains a real simulated target displacement. Move next component or Reroute next tray queues a declared change for the next stage. Fixture re-indexing, arm home, part orientation and velocity resets are explicit; this is not a continuous conveyor or assembly simulation.
7. **Gate the release.** Workspace → Release checks. Compare different policies against the selected saved case or a generated suite. Local supports frontier/Jev; the current Modal image supports scripted procedural kinematics. A single pair uses minimum 1 only for a scoped reproduction; use minimum 3 or more for suites. Do not lower the gate merely to show green.
8. **Show cloud scale.** Parallel runs → 50 or 100 pairs → baseline/candidate → up to four workers → Run on Modal CPU. Inspect actual queue/outcomes, measured overlap and a completed case's persisted trace and recorded 3D states. 100 cases means 200 episodes, not 100 simultaneous containers.
9. **Optional reconstruction.** Camera capture → Reconstruct camera objects in 3D → select a tight object-only box. Enable known footprint: chocolate 14 × 4 cm, blue 6 × 10 cm. Hyper3D receives only the selected crop after the explicit button. Height remains declared; normalized workspaces retain relative scale. Wait for an actual successful mesh before featuring it. The mesh changes appearance, never collision geometry or oracle results.

## One-minute recording

Preload the physical regression, a completed native production batch and the actual 100-case Modal run. Keep their recorded-evidence labels visible. For a fresh live controller recording, start it before capture and narrate the part actually on screen. Do not promise a provider response will fit into a fixed second.

- **0–8 s — Physical input, Workspace.** “FAULTLINE is CI/CD for robotics. We capture a failure in a real workcell and turn it into a repeatable test.” Show the real tabletop feed and corresponding objects.
- **8–20 s — Regression tests.** “This target moved after approach. We preserved the starting scene and disturbance, so every policy faces the same test.” Show the genuine baseline rejection, saved case and hash.
- **20–34 s — Controller evidence/native RoboSim.** “Here is a recorded fresh execution: Jev supplies feedback, the frontier model chooses actions, and the native simulator executes them. An independent evaluator checks the result.” Show the actual assisted policy ID, decision evidence and outcome. Say PASS, failure or escalation exactly as displayed.
- **34–46 s — Production line.** “The same harness handles multi-stage workflows, with contact physics and recovery when the work changes.” Show the actual native robot and stage queue. “These fixture stages reset between operations.”
- **46–60 s — Parallel runs.** “We also executed 100 paired scenarios on Modal: 200 real episodes. This candidate is blocked because it violates a rule. Teams can improve a policy without silently shipping a regression.” Show the actual completed grid, worker overlap and BLOCK gate.

Optional features need not all fit into the submitted minute. Use the full rehearsal for a longer conversation; show Hyper3D only after an actual asset succeeds.

## Record and verify

Use Record session in Workspace or macOS screen recording. In the chooser, select the FAULTLINE application/tab, not the standalone Desk View window. Browser recording stops after 60 seconds; download and play the whole file. Check readability, the actual object move, source labels, controller identity, audio if recorded, and the final gate. Keep the original take. Existing fallback video: `data/submission/faultline-pick-60s.mp4`.

Before submission, confirm the final chosen one-minute file plays and the submission form has the correct team details, repo link and video link/file. The working product and source checks are separate from successful submission of that form. Do not claim external submission until it has actually completed.


## Verified evidence for this take

- Physical displacement regression: `CAPTURE-5e049d873f`; saved plain-frontier paired results exist for all three requested models.
- Native four-stage frontier batch: `production_2512bc58907e`, GPT 6.1 Sol + Jev, four verified PASS stages and 104 actual model calls.
- Native operator reroute: `production_38e257a83377`, scripted reobserve, four verified PASS stages with an applied next-stage tray reroute.
- Native scripted batch: `production_d4bec2862db3`, four verified PASS stages. The earlier failed reverse-transfer experiment remains `production_741c3eed55fd`.
- Modal scale: `bench_1225904289db`, 100 pairs / 200 completed episodes, no execution errors, measured worker overlap 3, gate BLOCK for a forbidden-rule violation. Candidate completed 60 of 100 cases; do not present the suite as passing.
- Larger warehouse release check: `bench_dbb6b72f5228`, 12 pairs / 24 Modal executions, gate BLOCK at 75% candidate completion against its 80% threshold.

Hyper3D is implemented and contract-tested, but a successful paid generation from the current selected camera object must be observed before claiming it was demonstrated. It is optional for the submitted evidence loop.
