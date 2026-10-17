# Jev integration

The integration uses TypeSafe's official `POST https://api.typesafe.ai/v1/systemone` endpoint and pins **`jev-1.14.0`**. The official model page identifies it as the newest release, available since 14 October 2026. `jev-preview` currently points at 1.14; `jev-latest` points at 1.13. Pinning avoids an alias changing during a replay. Checked on 17 October 2026. [Models](https://docs.typesafe.ai/models), [HTTP contract](https://docs.typesafe.ai/api).

## What is implemented

`backend/jev.py` contains two optional, explicit advisory operations. Neither starts automatically, changes a tracker estimate, decides task success, or changes the deterministic release gate.

* `await triage_episode(scenario, result, events)` submits structured evidence from one actual recorded simulation episode. One call batches a Choice for failure cause, a Noul for whether another observation would help, and a Score for operational severity. The response retains all option probabilities and reported confidence. Provider error text and raw frontier text are excluded from the submitted log. Jev's diagnosis remains advisory alongside the independent evaluator result.
* `await ground_objects(jpeg, descriptions, frame_ref, crop_metadata=None)` asks one presence Noul and one Box per named object in the same request. It submits one tabletop JPEG as multipart data with `TypeSafe-Danger-Zone-Images: true`. All returned edges and confidence values are validated. The local suggestion rule requires presence probability at least 0.8 and Box confidence at least 0.6. These thresholds are local prototype choices, not measured detector accuracy or a vendor guarantee. Every suggestion requires operator confirmation before seeding the existing tracker.

Box always returns four edges, including when the target is absent, which is why the companion presence Noul is required. Box coordinates are fractions of the **uploaded crop**, measured from its top-left corner. When supplied by `crop_tabletop`, metadata preserves the source frame SHA-256, source size, exact crop bounds, padding and upload SHA-256. Grounding also returns `source_frame_bbox_xywh` for a confirmation overlay. A box extending into synthetic padding is marked unsuitable for tracker seeding. [Box semantics](https://docs.typesafe.ai/primitives/box), [image wire format](https://docs.typesafe.ai/images).

Images and Box are explicitly experimental in the vendor documentation. They are a useful candidate for semantic object initialization or manual reacquisition; they are not the active 5 FPS appearance tracker and do not measure depth, object height, robot joints or physical success.

## Local configuration

Use `JEV_API_KEY` or `TYPESAFE_API_KEY` in the ignored `backend/.env`. The module reads keys only on the server. No browser key or alternative service URL is accepted. Calls record the requested and actual response model, reported token usage, measured wall latency, request SHA-256, scope and validated response. HTTP failures, timeouts and malformed output fail explicitly with no substituted result. Tests use only `httpx.MockTransport` and dummy credentials.

```sh
.venv/bin/python -m pytest backend/tests/test_jev.py -q
.venv/bin/python scripts/verify_jev.py
```

The verifier's default mode prepares the upload without sending it. It uses saved physical case `CAPTURE-5e049d873f`, replay episode `ep_faa3ffa41c204d06`, and frame `frames/cam_df27f62200fd/00003029.jpg`. Its inspected crop is `[70, 20, 570, 310]` in source pixels: a 500×290 tabletop image showing the three snack packets, excluding people and the room. Source frames remain unchanged.

## Actual-call status

**Both real Jev calls completed after specific user approval of the crop, log and external TypeSafe endpoint.** An earlier attempt was stopped before execution by automatic approval review. The user then explicitly approved “Allow the cropped tabletop image and log.” The authorized verifier executed each planned call once, with no retries or substituted results:

```sh
.venv/bin/python scripts/verify_jev.py --execute
```

The actual response model was **`jev-1.14.0`** for both calls. `data/jev-verification.json` retains exact validated responses, usage, image hashes, crop bounds, request hashes and measured wall latency:

* Triage: **1,470.62 ms**, 22,993 input tokens and 127 output tokens. Jev selected `stale_target_pose` with probability 0.95 and confidence 0.94; re-observation Noul 0.86; severity Score 2.0. These are the provider's advisory values, not measured classifier accuracy.
* Grounding: **763.46 ms**, 905 input tokens and 118 output tokens. The red parcel had presence probability 0.92 but Box confidence 0.44, so the local confidence rule correctly withheld that suggestion. The orange parcel had presence 0.97 / Box confidence 0.83; the blue parcel 0.89 / 0.62. Those two boxes are available for operator confirmation. No object estimate was changed automatically.

The 18 mocked contract tests also passed; those tests cover transport shape and validation rather than model quality. These two real requests establish access and responses on this example. They do not establish tracking accuracy or benchmark reliability. The measured time includes local HTTP transport and response processing, rather than the camera's frame rate or robot execution time.

The active core remains OpenCV tracking plus independently evaluated symbolic execution. Jev is an optional typed diagnosis and experimental grounding enhancement. [Structured state](https://docs.typesafe.ai/concepts/state).
