# FAULTLINE RoboSimStudio asset import

Upstream: https://github.com/robosimstudio/robosimstudio

Pinned commit: `73739abe212f963e8a9f5862b27bca370df091a7`. The imported nine STL files are byte-identical copies of `assets/embodiments/yam_i2rt/assets/`. Their geometry and units were not changed. A second byte-identical copy sits beside the original MJCF in `third_party/robosimstudio/assets/embodiments/yam_i2rt/assets/`, so native `meshdir="assets"` resolves locally without model rewrites or external symlinks. The original right-arm MJCF and kinematics URDF are retained under their source paths here. Exact checksums, byte sizes, triangle counts and visual origins are in `asset-manifest.json` and `public/robots/yam_i2rt/manifest.json`.

The YAM arm and linear_4310 gripper models are MIT licensed, Copyright (c) I2RT Robotics. The local model `LICENSE` and public asset `LICENSE` preserve that notice. RoboSimStudio itself is Apache-2.0, Copyright 2026 Kaiyuan Chen; its root `LICENSE`, `NOTICE`, and full `assets/PROVENANCE.md` are copied unchanged. No unimported third-party mesh is claimed or loaded.

FAULTLINE presents the imported geometry with a white/graphite material override; original mesh vertices and model origins are preserved. The backend supplies each mesh's authoritative world pose, including the MJCF geom-local transform. Rendering does not solve IK, animate joints independently, or load upstream simulation code. Rendering the meshes alone does not imply execution of the RoboSimStudio Newton/Warp physics runtime.

An optional runtime-source import copies exactly the 198 core Python files listed and hashed in `runtime-manifest.json`, unchanged at the same pinned commit. It does not copy upstream AGENTS/CLAUDE instructions, skills, tests, media, installers or bytecode caches. Dependencies and real CPU execution are handled separately by the local worker; the existence of vendored source is not a claim of successful physics execution. The core package remains covered by the copied Apache-2.0 licence and NOTICE.

Reproduce from a checkout at the pinned commit:

```sh
python3 scripts/import_robosim_assets.py --source /path/to/robosimstudio
python3 scripts/import_robosim_assets.py --source /path/to/robosimstudio --include-runtime
python3 scripts/import_robosim_assets.py --verify
```

The importer reads XML and copies a fixed file allowlist; it executes no upstream program.
