# FAULTLINE Pick: executable demo and submission

**Hack day: 17 October 2026. Submission: 16:00 Europe/London (BST). Freeze optional work by 15:15.** Reserve 15:15–16:00 for local recording, verification, packaging and submission. If the deadline is already close, cut Hyper3D, LiDAR, Jev, Modal and scenario count in that order.

## Launch and preflight

From the repository root:

```sh
.venv/bin/python scripts/smoke_test.py
.venv/bin/python scripts/run_benchmark.py --count 10
bash scripts/dev.sh
```

Open [Live Lab](http://localhost:3300/lab). The API health endpoint is [local backend health](http://127.0.0.1:8787/api/health). The dev script refuses occupied ports and only cleans up the process groups it started. Keep a working server running while rehearsing.

Add actual keys to the ignored `backend/.env` using `backend/.env.example` as a guide. Select `gpt-6.1-sol`, `gpt-6-astra` or `claude-opus-5-5` only after its key is present. Complete at least one actual provider episode before describing a frontier model as demonstrated. Scripted policies remain available without keys. Never show the env file or credential headers in the recording.

Mount the laptop webcam or Continuity Camera above a contrasting table. Put an unmarked chocolate bar/parcel, small opaque carton and highlighter in view. Connect the camera, confirm the image changes live, select the workspace corners clockwise (top-left, top-right, bottom-right, bottom-left), and optionally enter measured width/depth. Leave units normalized if the workspace has not been measured. Then draw a bounding box for each object and assign persistent IDs including `chocolate_A`. Move each item slightly, remove your hand, and verify identity and estimated pose update. Reseed a lost object before running.

## Exact live loop

1. With objects still, run `scripted_open_loop` once. The virtual manipulator must grasp and release the selected item, and the independent oracle must report its actual result.
2. Reset to the tabletop scene. Start a new baseline episode with a visible action delay. After the first approach action, slide the physical target well away from its old position. Remove your hand before the next camera estimate. The unheld virtual target must move, and the grasp must be rejected with a logged cause such as `TARGET_DISPLACED`. If tracking is uncertain, correct/reseed and try again; do not relabel an operator-injected displacement as physical capture.
3. Save/create the regression from this completed episode. Confirm the inferred before/after displacement and source. Inspect the saved case: it must contain the initial scene, action-boundary disturbance, provenance and evaluator version. Keep its case ID visible.
4. Choose `scripted_reobserve` or an available requested frontier model and use **fresh rerun** on that saved case. Confirm a new episode ID with the same scenario hash; an old trace playback does not count. The candidate makes its own actions and receives its own independently evaluated outcome. Preserve a truthful fail/escalation if that is what happened.
5. Run the paired comparison on saved cases or a small generated suite. Show completed counts, one failure inspector and the actual release gate. Appropriate help is `ESCALATED`, not a successful placement. Separate physical-capture, procedural-scripted and frontier-policy episodes in narration.

The headless smoke script proves the engine/persistence path; it does not prove webcam tracking. Its evidence pointer is `data/smoke-latest.json`. The CLI benchmark pointer is `data/benchmark-latest.json`; the referenced report includes result and trace references for each execution. A red gate is a valid demonstration of a test system detecting a release problem.

To execute only a saved physical case from the command line, use its actual filename:

```sh
.venv/bin/python scripts/run_benchmark.py --count 0 --scenario data/scenarios/ACTUAL_CASE_ID.json --candidate gpt-6.1-sol --minimum-cases 1
```

## One-minute storyboard

- **0–7 seconds:** Tabletop camera and virtual workcell together. “FAULTLINE turns a physical failure into a repeatable robot-policy regression test. This manipulator is simulated.”
- **7–18 seconds:** Slide the unmarked target; point out the live camera estimate moving the corresponding virtual parcel. “A camera estimate updates the same workcell state used by the executor.”
- **18–30 seconds:** Show the baseline's stale grasp rejection and exact logged cause. “The controller acted on an old position. The executor rejects it.”
- **30–43 seconds:** Save the real failure and start a fresh candidate rerun. Show the case ID and new episode. “We preserve the starting scene and the disturbance, then run another policy from a fresh reset.”
- **43–55 seconds:** Show the candidate's actual result, completed benchmark cases and gate. “The independent evaluator verifies placement and checks individual regressions.” Say the actual outcome, including BLOCK if displayed.
- **55–60 seconds:** “FAULTLINE: CI/CD for physical AI. Today: live RGB capture and simulated manipulation. Next: real robot adapters.”

Rehearse the click order before recording; preselect a genuine already-executed suite if running it on camera would exceed the minute. Label it as a saved benchmark. Do not time-compress inference without a visible edit or claim a scripted trace came from a model.

## Record locally

Use **Shift–Command–5**, choose the application/selected portion, set a local save location and microphone under Options, then Record. Stop with the menu-bar control or Control–Command–Escape. Preview the saved file with audio immediately. These are Apple's [screen recording instructions](https://support.apple.com/en-us/102618). Capture a separate phone angle of the physical move if useful, keeping the final edit local. The browser's camera recording, when available, records camera video; OS capture records the workcell, logs and gate together.

Save the final one-minute file as `data/submission/faultline-pick-60s.mov` (or the actual exported extension). Keep the original full recording alongside it. This file is not created by the smoke script; verify the actual video exists and plays before submission. Do not spend the final buffer adding integrations.

## Submission check

- Source includes setup instructions, ignored env files/templates, architecture/contracts, smoke and benchmark commands. Record the final Git commit/ref used for the video.
- Include the actual physical case JSON and both completed episode result/trace files, with any referenced consented tabletop frames. `data/` is ignored, so evidence needs deliberate packaging outside the source commit.
- Include a completed benchmark report and its gate configuration. Report actual completed cases/episodes, model IDs and data provenance; no fixture or queued case is a completed test.
- Include the local 60-second video, verify playback, sound, readable labels and the saved case/new episode sequence.
- Remove credentials and unrelated personal footage from the submission bundle. Keep a local copy before uploading.
- Submit repository/ref, video and concise scope before **16:00 London**. Confirm the submission site's success state and preserve its receipt locally.

If camera or network fails during judging, show the saved physical evidence and fresh local scripted rerun, explicitly labelling the physical clip as recorded. If no physical capture has succeeded, say so and demonstrate the genuine procedural engine separately. Never manufacture the missing trial.
