# Selected-object visual reconstruction

`backend.hyper3d` implements Hyper3D Rodin's actual image-to-3D API. It reads `HYPER3D_API_KEY` or `RODIN_API_KEY` from the process environment or `backend/.env`, without returning credentials to clients. Credential presence is confirmed locally; a paid live generation has not yet been verified because it requires an actual selected camera object. Tests use explicit mocked responses and synthetic test images that are never uploaded.

The application holds `session.lock` while calling `begin_job(storage, session, object_id)`, then starts `execute_job(storage, job_id)` in a background task. `get_job` reads progress; `get_assets(storage, session_id)` returns only the original camera session's jobs. The application must enforce session authorization on job, crop and model routes. Local artifacts reside in `data/reconstructions/<job_id>/`; the browser model URL is `/api/faultline/assets/<job_id>/model.glb`.

Input is the exact selected rectangle from the latest saved camera JPEG, with no surrounding padding. The service requires a visible tracked object, a fresh frame belonging to the camera session, and a rectangle wholly inside the calibrated workspace. Full-frame boxes and person/room labels are rejected. These guards do not constitute semantic person segmentation: the operator must select a tight object-only rectangle. The source frame itself is never uploaded. Crop and frame hashes, rectangle coordinates and source frame reference are retained for provenance.

The request uses `Gen-2.5-Extreme-Low`, `Raw` topology, GLB output, 10,000 target faces and PBR material. These settings meet the documented Fast-mode conditions. Generation is submitted once; a timeout or failure never automatically starts another paid task. Polling starts at five seconds, backs off to 30 seconds, handles HTTP 429 and has a 15-minute deadline. Every subjob must report Done before downloading. Provider failures remain visible; no placeholder mesh is generated.

Returned GLBs are checked for format, length, embedded asset references and size before storage. Signed download URLs and subscription keys are not returned or persisted. API authorization is never attached to asset downloads. Job states are QUEUED, RUNNING, SUCCEEDED and FAILED; `progress` is a human-readable stage, not an invented numeric percentage.

The asset is visual only. Existing object dimensions are reported as declared/assumed and depth is explicitly unmeasured. RGB reconstruction does not establish physical scale. Neither simulation collision geometry nor frozen scenario manifests are modified. The viewer should fit the mesh to the existing declared dimensions while retaining this distinction.

Official sources, consulted 17 October 2026:

- [Rodin Gen-2.5](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5): generation fields and Fast mode.
- [Quick Start](https://docs.hyper3d.ai/en/get-started/quick-start): authenticated submission and asynchronous workflow.
- [Check Status](https://docs.hyper3d.ai/en/api-specification/check-status): subscription-key polling and subjob states.
- [Download Results](https://docs.hyper3d.ai/en/api-specification/download-results): task UUID and signed asset delivery.

An optional `physical_footprint_m=(width, depth)` records a supplied real footprint. Values must be positive, finite and no larger than five metres. In a metric workspace, these values set the visual mesh's XY fit while existing height remains assumed (`scale_source=measured_footprint`). In a normalized workspace, the fit preserves the existing longest planar extent and orientation but uses the supplied footprint ratio (`measured_footprint_relative`); `metric_scale_verified` remains false. The original tracker object and its collision dimensions remain unchanged. A known footprint does not measure height or turn normalized positions into metres.
