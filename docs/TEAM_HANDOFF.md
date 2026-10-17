# Team handoff

The integrated application is at **http://localhost:3300/lab**. The original frontend at `/` and `/runs/*` remains a synthetic preview; use `/lab` for real local execution and evidence.

## Start a checkout

```bash
pnpm install
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cp -n backend/.env.example backend/.env
pnpm dev:full
```

Scripted policies and generated warehouse cases work without provider credentials. Add your own keys to the ignored `backend/.env` for frontier policies or Jev. Do not put keys in `NEXT_PUBLIC_*` variables. Ports are 3300 for Next.js and 8787 for the Python API.

Select **Warehouse demo** in the Lab to create a declared metric layout and preview it. Select a target and policy, then explicitly run the scenario. Previewing creates no execution result. Camera trials need a new browser camera session and calibration on each machine.

## Areas that can be worked on separately

- `src/app/lab/` owns the Lab orchestration and layout. `src/components/faultline/Warehouse3D.tsx`, `World.tsx`, and `warehouse-viewer.css` own the shared-state renderer. Coordinate with the integration owner before editing these files.
- `backend/` owns scene contracts, robot and policy adapters, deterministic execution, camera tracking, independent evaluation and storage. `contracts/faultline.schema.json` is generated from the Python models.
- The legacy frontend in `src/app/page.tsx` and `src/app/runs/` is separate from the Lab. Its fixtures are not real benchmark evidence.

Use separate feature branches and agree on file ownership before overlapping edits. Robot selection and policy selection are independent; saved scenario geometry, robot configuration and hashes must remain immutable.

## Verification and current limits

```bash
pnpm check
pnpm backend:test
pnpm smoke
```

The latest local backend validation passed 95 tests. The larger warehouse suite executed 24 real local episodes: the obstacle-aware policy completed nine of twelve cases and appropriately escalated three; its release gate remains BLOCK at 75% versus the configured 80% completion threshold. These results are evidence, not an instruction to loosen the gate.

The 3D visual upgrade is still undergoing browser verification. A plan view is available when WebGL cannot start. Robot poses are backend FK/IK estimates in a kinematic simulator; there are no contact dynamics or physical robot trials.

Recorded camera frames, immutable captured cases, provider response logs, benchmark results and demo recordings live under ignored `data/` and are **not included in GitHub**. A fresh checkout can generate and run new warehouse cases, but cannot replay another machine's physical capture without separately receiving its evidence bundle. Keep real evidence separate from synthetic fixtures and never manufacture results to populate the UI.

Read `README.md`, `docs/FAULTLINE_ARCHITECTURE.md`, and the three authoritative specifications under `faultline_final/` before changing contracts or controller behavior.
