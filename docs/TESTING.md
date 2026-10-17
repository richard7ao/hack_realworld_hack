# Testing the robotics CI workspace

Open http://localhost:3300/lab. The original `/preview` and `/runs/*` screens are labelled synthetic frontend previews; their fixtures are not execution evidence.

## Primary workflow

1. Choose an environment, then a saved scenario or a new supported setup. Loading the scene is a preview, not a policy execution.
2. Select an available controller and explicitly run it. Inspect the running episode ID and executed policy; a changed selection applies to the next run.
3. Review the evaluator result and execution log. Events show a readable summary first; expand full payloads for actual provider requests, returned actions, responses, errors and provenance. Enable observations and state when deeper inspection is needed.
4. Save a completed failure as a regression. Verify its initial scene, immutable disturbance schedule, source and scenario hash.
5. In Release checks, select baseline and candidate and execute a fresh paired comparison. Each episode must have its own ID and result against the same saved manifest. Saved trace playback does not create a new execution.
6. Inspect case outcomes, completed pair counts, critical regressions and the release gate. A blocked gate is a valid result; preserve its configured threshold.

Guided controllers call Jev before the frontier chooses an action. Inspect those actual calls in controller evidence and `policy.decision` payloads. Post-run diagnosis is a separate explicit request; saved API verification belongs to its recorded case, not the current episode. Provider failures and completed advice remain visible even if the downstream action request fails.

Use **Record session** to capture the selected screen for up to 60 seconds, then **Download recording**. Record only approved content and check playback. The recording documents the session; it does not replace saved execution evidence.

## Camera workcell: the core physical failure

1. Connect the laptop/Continuity Camera, or share the Desk View window. Keep its framing fixed.
2. Set workspace corners and select contrasting, ordinary unmarked objects. Metric side lengths require actual measurements; normalized calibration is sufficient for the original Cartesian demonstration.
3. Choose `scripted_open_loop` and a 4-second action pace. Start the pick, pause after approach, move the real target, remove your hand and resume.
4. Inspect the actual failure and accepted disturbances. Review and confirm **Create regression test**.
5. Select that saved case and use **Fresh rerun** with another available policy. It receives a fresh environment and the same saved disturbance schedule; camera updates cannot alter the replay.

This is the original narrative: physical failure → immutable test → policy change → independent verification. A virtual grasp does not prove a physical robot could grasp the object.

## Warehouse workcell: broader coverage

1. Select **Warehouse kinematics** and load a declared 4 × 3 m layout. Previewing runs no policy.
2. Choose an available robot profile and policy. Robot selection applies when creating a new layout; saved cases keep their original robot geometry.
3. In Release checks, choose open loop versus obstacle-aware and the 12-pair warehouse suite.
4. Inspect completed executions, escalations, collision failures and gate reasons. The existing candidate completes 9/12 cases, so its 80% gate correctly remains BLOCK. Do not lower the threshold to make the presentation green.

This view expands test coverage with explicitly procedural scenes and rigid-link kinematics, rather than claiming additional physical captures.

## RoboSim physics: native simulated manipulation

1. Install the optional runtime with `bash scripts/setup_robosim.sh` and select **RoboSim contact physics**.
2. Select the saved **displacement** scenario and run **Scripted · open loop**. Expect `TARGET_DISPLACED`.
3. Choose **GPT 6.1 Sol + Jev feedback** and run the same saved scenario. Astra and Opus are also available. These use real external API calls and require the corresponding local keys.
4. Watch the executed model, real call count, latest returned action, Jev feedback and measured robot/contact state. Camera movement changes only the view. The evaluator checks placement independently.
5. Load a saved assisted benchmark in Release checks to inspect the baseline/candidate pair, hashes, trace and release gate. Recorded-state playback is separate from fresh execution.

RoboSim uses the original YAM meshes and actual CPU contact physics. The right arm is active; the left arm is idle. These native cases are procedural and are not automatically reconstructed from the current RGB capture. Their role is to test the same failure/recovery contracts with richer manipulation dynamics.

Lead the pitch with the saved failure and the verified policy comparison. The detailed robot scene explains what happened; it is not the product's evidence or success criterion.
