# FAULTLINE Pick: submission working notes

Deadline: **16:00 Europe/London, 17 October 2026**. This file is preparation, not a submission receipt. Final evidence selection, local video verification and submission confirmation remain required.

## Description draft

FAULTLINE Pick turns a physical disturbance into a repeatable robot-policy regression test. A laptop camera, including a shared macOS Desk View window, tracks ordinary unmarked parcels. Their estimated positions update a virtual warehouse workcell. Interchangeable policies operate the same simulated Cartesian gripper through a typed action interface.

When someone moves a parcel after approach, an open-loop controller can attempt a stale grasp. FAULTLINE preserves the initial scene, observed disturbance, action boundary and execution trace as an immutable case. It reruns other policies from fresh environments and checks placement and constraints with an independent evaluator. The demo includes a real camera-captured displacement where the original controller failed and a reobserving controller completed the saved case. Actual API executions of GPT 6.1 Sol, GPT 6 Astra and Claude Opus 5.5 also completed that same saved displacement case. It also preserves a tracking-loss case where the alternative asked for help and the release gate remained blocked.

The current manipulation is simulated. RGB supplies planar estimates; object height and dimensions are declared assumptions. Frontier policies receive structured observations through adapters. No physical robot execution or broad reliability certification is claimed.

## Verified physical evidence

- `CAPTURE-5e049d873f`: real Desk View RGB displacement; original live episode `ep_b8e0a46defa547b5` failed with `TARGET_DISPLACED`. Fresh paired benchmark `bench_cli_6173795bc59e` reran the immutable case: `scripted_open_loop` episode `ep_7ac52c000f0e4a89` failed with `TARGET_DISPLACED`; `scripted_reobserve` episode `ep_e5fe0434317046ea` passed with `CORRECT_ITEM_VERIFIED_IN_DESTINATION`. Its gate passed for **one paired case**, configured minimum 1 and completion threshold 0.8.
- `CAPTURE-9526adbd43`: real Desk View movement with tracking loss; original live episode `ep_8ba275b345064bdb` failed with `OBJECT_NOT_VISIBLE`. Fresh paired benchmark `bench_cli_4afdfc3507ab` produced baseline `FAIL` and candidate `ESCALATED / APPROPRIATE_HELP`. The gate was **BLOCK**, because a request for help is not a successful placement.
- These are two captured cases, not an estimate of general success rate. Their camera frames, original episodes, immutable scenarios and rerun traces are separate evidence. The capture includes uncertainty and does not establish accurate translation for every tracked event.

## Completed frontier comparisons on the captured displacement

`data/physical-frontier-verification.json` records **one physical capture trial**, followed by **three fresh frontier candidate executions and three fresh scripted baseline executions** on the same immutable `CAPTURE-5e049d873f` manifest. All used scenario SHA-256 `1f36b47976eaa916316d99a4a7ffbf0637962cba56fbd9bc5d0eeffeeb9be0ac`. The models received symbolic observations and action history; raw camera images were not sent to the policy adapters.

- `gpt-6.1-sol`: canonical report `data/benchmarks/bench_cli_076213d8ac05.json`; candidate `ep_7a2987f9fed341cd` completed **11 actions and 11 real model calls**, with `PASS / CORRECT_ITEM_VERIFIED_IN_DESTINATION`. Its fresh scripted baseline `ep_80d322aaf8a24991` failed with `TARGET_DISPLACED`.
- `gpt-6-astra`: canonical report `data/benchmarks/bench_cli_34828242e604.json`; candidate `ep_b8f301ede9c94acc` completed **10 actions and 10 real model calls**, with `PASS / CORRECT_ITEM_VERIFIED_IN_DESTINATION`. Its fresh scripted baseline `ep_2802f1e155ec4433` failed with `TARGET_DISPLACED`.
- `claude-opus-5-5`: canonical report `data/benchmarks/bench_cli_75963efdc60a.json`; candidate `ep_b8fd95eefb0e48a1` completed **14 actions and 14 real model calls**, with `PASS / CORRECT_ITEM_VERIFIED_IN_DESTINATION`. Its fresh scripted baseline `ep_832f4002953b4b4e` failed with `TARGET_DISPLACED`.

That is **35 actual frontier model calls** in total. Each provider response has a real response ID and a response model matching the requested model. Persisted checks confirm distinct fresh episode IDs, matching manifest hashes, contiguous trace sequences, executor action counts, correct target release, full footprint containment, empty gripper after release, no recorded hard violations and matching terminal evaluation/result.

Each comparison's gate is **PASS for one paired case**, with `minimum_cases=1` and `completion_threshold=0.8`. The three comparisons reuse one physical scene; they do not constitute three physical trials or a reliability/generalization estimate. Canonical episode evidence is under `data/episodes/`; the original per-model execution directories remain preserved under `data/physical-frontier/`. This focused result does not change the earlier tracking-loss **BLOCK** or the broader procedural suite's **BLOCK**.

## Other executed scope

- The actual local procedural suite `bench_cli_4ffcfe3e9975` ran 10 cases and 20 scripted episodes. Its gate was **BLOCK**. Retain the report when discussing the broader suite; do not substitute the one-case passing gate for it.
- Actual provider episodes on the single procedural case `PICK-target_displacement-42017` passed for `gpt-6.1-sol` (`ep_0a6be50ecff44407`), `gpt-6-astra` (`ep_f52f90309d484abd`) and `claude-opus-5-5` (`ep_31c01134adbb48c1`). `data/frontier-verification.json` records that narrow scope. These are actual API executions, not physical capture or a broad model benchmark.
- The completed physical frontier comparisons above have separate durable traces and reports from these earlier procedural runs. Count their physical trial and fresh executions separately.

## Package selected evidence

Run from the repository root:

```sh
.venv/bin/python scripts/package_evidence.py \
  --scenario CAPTURE-9526adbd43 \
  --scenario CAPTURE-5e049d873f \
  --benchmark bench_cli_4afdfc3507ab \
  --benchmark bench_cli_6173795bc59e \
  --episode ep_8ba275b345064bdb \
  --episode ep_b8e0a46defa547b5 \
  --output data/submission/draft-evidence
```

`--scenario` and `--benchmark` accept an ID or an explicit JSON path and can be repeated. `--episode` accepts an episode ID and can be repeated. `--data-dir` selects a different local evidence root. Capture episodes referenced by scenario provenance and all episodes referenced by benchmark results are included automatically. `--video /absolute/path/to/actual-recording.mov` adds an existing operator-selected recording. A missing supplied reference stops packaging before any output is created.

The package copies original JSON/JSONL bytes, checks episode and scenario hashes, and includes only explicitly referenced camera frames. It does not sweep camera folders, read env files, generate results or create a video. `manifest.json` lists file sizes and SHA-256 hashes; `SHA256SUMS` also covers the manifest and generated `SCOPE.md`. Repeating an identical invocation is safe and produces the same bytes; changed selections require a new output directory.

The existing `draft-evidence` contains **2 captured cases, 2 comparison reports, 6 episodes and 424 referenced tabletop frames**. It predates the three completed physical frontier comparisons and contains **no final video**. The draft is local under ignored `data/`; it is not automatically included in a source commit or uploaded anywhere.

To prepare a separate review package containing all five physical comparison reports, use a new output directory:

```sh
.venv/bin/python scripts/package_evidence.py \
  --scenario CAPTURE-9526adbd43 \
  --scenario CAPTURE-5e049d873f \
  --benchmark bench_cli_4afdfc3507ab \
  --benchmark bench_cli_6173795bc59e \
  --benchmark bench_cli_076213d8ac05 \
  --benchmark bench_cli_34828242e604 \
  --benchmark bench_cli_75963efdc60a \
  --output data/submission/review-evidence-with-frontier
```

Final package selection remains with the submission owner. **The final one-minute video is still absent** until an actual recording is supplied and verified; this documentation update does not create one.

Before attaching the final package, check its generated `SCOPE.md`, verify all checksums, review referenced imagery, and play the actual final recording for readable labels and audio. The packaging tool checks file integrity; it cannot certify the correctness of estimates or the content of a screen recording.

## Fill before submitting

- Team name: **[fill]**
- Teammates and contributions: **[fill with confirmed names]**
- Repository URL: **[confirm final URL and access]**
- Commit/ref demonstrated: **[fill after final source snapshot]**
- Final one-minute video path/link: **[fill after local playback]**
- Final evidence package path/link: **[fill after selection and checksum review]**
- Submission URL and required fields: **[fill]**
- Submission confirmation/receipt: **[fill only after the site confirms success]**

Use [DEMO.md](DEMO.md) for the one-minute storyboard and [INTEGRATIONS.md](INTEGRATIONS.md) for adapter scope and official integration references.
