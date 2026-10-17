# Testing the three views

Open http://localhost:3300/lab. The original `/` and `/runs/*` screens are labelled synthetic frontend previews; their fixtures are not execution evidence.

## Camera workcell: the core physical failure

1. Connect the laptop/Continuity Camera, or share the Desk View window. Keep its framing fixed.
2. Set workspace corners and select contrasting, ordinary unmarked objects. Metric side lengths require actual measurements; normalized calibration is sufficient for the original Cartesian demonstration.
3. Choose `scripted_open_loop` and a 4-second action pace. Start the pick, pause after approach, move the real target, remove your hand and resume.
4. Inspect the actual failure and accepted disturbances. Review and confirm **Create regression test**.
5. Select that saved case and use **Fresh rerun** with another available policy. It receives a fresh environment and the same saved disturbance schedule; camera updates cannot alter the replay.

This is the original narrative: physical failure → immutable test → policy change → independent verification. A virtual grasp does not prove a physical robot could grasp the object.

## Warehouse demo: broader coverage

1. Select **Warehouse demo** and load a declared 4 × 3 m layout. Previewing runs no policy.
2. Choose an available robot profile and policy. Robot selection applies when creating a new layout; saved cases keep their original robot geometry.
3. In CI Bench, choose open loop versus obstacle-aware and the 12-pair warehouse suite.
4. Inspect completed executions, escalations, collision failures and gate reasons. The existing candidate completes 9/12 cases, so its 80% gate correctly remains BLOCK. Do not lower the threshold to make the presentation green.

This view expands test coverage with explicitly procedural scenes and rigid-link kinematics, rather than claiming additional physical captures.

## RoboSim physics: native simulated manipulation

1. Install the optional runtime with `bash scripts/setup_robosim.sh` and select **RoboSim physics**.
2. Select the saved **displacement** scenario and run **Scripted · open loop**. Expect `TARGET_DISPLACED`.
3. Choose **GPT 6.1 Sol + Jev feedback** and run the same saved scenario. Astra and Opus are also available. These use real external API calls and require the corresponding local keys.
4. Watch the executed model, real call count, latest returned action, Jev feedback and measured robot/contact state. Camera movement changes only the view. The evaluator checks placement independently.
5. Load a saved assisted benchmark in CI Bench to inspect the baseline/candidate pair, hashes, trace and release gate. Recorded-state playback is separate from fresh execution.

RoboSim uses the original YAM meshes and actual CPU contact physics. The right arm is active; the left arm is idle. These native cases are procedural and are not automatically reconstructed from the current RGB capture. Their role is to test the same failure/recovery contracts with richer manipulation dynamics.

Lead the pitch with the saved failure and the verified policy comparison. The detailed robot scene explains what happened; it is not the product's evidence or success criterion.
