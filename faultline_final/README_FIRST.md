# FAULTLINE Pick — Final Hackathon Handoff

**Read in this order:**

1. `FAULTLINE_PRD.md` — full product goals, UX, business thesis, acceptance tests and demo.
2. `FAULTLINE_BUILD_BRIEF.md` — engineering contracts, architecture, modules, endpoints, scenario runner, milestones, agent kickoff prompt.
3. `CAMERA_LIDAR_INTEGRATION.md` — iPhone camera connectivity, Safari secure camera path, optional native ARKit LiDAR sensor bridge, calibration, unmarked tracking and code sketches.

## Highest-priority outcome

Physical object moved in front of a camera → simulator changes → virtual policy fails/recovers → case saved → **new execution** with another policy → result judged by deterministic evaluator → release comparison.

**Prioritise RGB over native depth during the hack.** The same scene-state schema can accept LiDAR later. No new model training is needed for this POC. Do not claim virtual robot grasps represent real hardware results.

**Submission cutoff: 16:00 local time on 17 October 2026.** Reserve time for offline video capture and repo/submission.
