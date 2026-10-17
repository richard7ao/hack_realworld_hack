# Paired benchmark execution on Modal

The local dispatcher runs independent episode event loops in up to four worker threads. Each A/B execution receives a fresh scenario copy, policy and environment. This provides actual overlapping execution, including for scripted policies that do not yield. It does not imply multicore CPU speedup under Python's GIL.

Modal workers run the same backend engine in CPU containers (one CPU, 512 MB, maximum four containers, 180-second timeout, no retry). They currently accept only procedural kinematic scenarios and the three scripted policies (open-loop, reobserve and obstacle-aware). Native RoboSim, camera captures and frontier provider credentials are excluded from this image. No secrets are mounted and only the backend package and worker source are uploaded.

From the repository root:

```sh
.venv/bin/python -m pip install 'modal>=1.5,<2'
.venv/bin/modal token new # only when no profile is already configured
.venv/bin/modal run modal/faultline.py --count 4 --data-dir data
.venv/bin/modal deploy modal/faultline.py
```

The deployment enables the application's `modal_cpu` dispatcher, which resolves `faultline-pick/worker` and calls `remote.aio`. Local benchmarks require no Modal account. Failed cloud calls produce explicit execution errors; they never create placeholder case results. Complete returned traces, scenario manifests, final worlds and oracle results are saved locally. Scenario hashes, case/policy identities, provenance IDs, worker timing intervals, contiguous trace sequences, trace episode identities, terminal oracle results and final world state are validated before writing any returned artifact. The worker reports its actual start/end timestamps, Modal input/call IDs and container task ID, so cloud execution and overlap can be inspected independently of client queue timing.

`backend.benchmark_dispatch.dispatch_cases` returns baseline/candidate CaseResult lists, errors, execution records, peak client concurrency and configured concurrency. Its synchronous progress callback receives queued, started, completed and failed events. A completed event includes the result and worker provenance. The caller must fail a benchmark with any execution errors even when the completed subset passes its gate.

Modal's official documentation confirms [parallel starmap semantics](https://modal.com/docs/guide/function-invocation-methods), [async remote.aio invocation](https://modal.com/docs/guide/async), and [container scaling](https://modal.com/docs/guide/scale). Queued/request concurrency is distinct from actual worker overlap; use returned worker timestamps and container IDs for the latter.

## Verified execution on 17 October 2026

The deployed adapter completed four warehouse case pairs (eight real episodes) through `dispatch_cases(..., backend="modal_cpu")`. The latest run after the atomic-storage fix shows two overlapping workers across three distinct Modal containers (an earlier verified run reached three overlapping workers across four containers). Evidence is in `data/modal-dispatch-smoke.json` and `data/modal-verification.json`. A separate four-pair CLI benchmark (`bench_modal_c58e8677da77`) completed all eight episodes with no execution errors and correctly produced a BLOCK gate for an obstruction violation. The deployment is [faultline-pick](https://modal.com/apps/vikkash27/main/deployed/faultline-pick). Historical verification is invalidated if the execution source fingerprint changes.
