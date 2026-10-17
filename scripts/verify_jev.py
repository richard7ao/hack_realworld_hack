"""Explicit real Jev calls on one saved captured case and inspected tabletop crop.

Default prepares the exact upload locally. --execute sends the cropped JPEG and
the saved simulation execution log to api.typesafe.ai; never any credentials in
output, full camera frame, surrounding room, or fabricated fallback results.
"""
import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.jev import JevError, crop_tabletop, ground_objects, triage_episode
from backend.storage import Storage


async def verify(args):
    store = Storage(args.data)
    scenario = store.load(f"scenarios/{args.case}.json")
    result = store.load(f"episodes/{args.episode}/result.json")
    if result["case_id"] != scenario["case_id"]:
        raise ValueError("Episode must execute the selected saved case")
    events = [json.loads(line) for line in store.path(result["trace_ref"]).read_text().splitlines()]
    frame_ref = scenario["initial_scene"]["frame_ref"]
    frame = store.path(frame_ref).read_bytes()
    crop, metadata = crop_tabletop(frame, tuple(args.crop))
    crop_ref = f"jev/{args.case}-tabletop.jpg"
    store.path(crop_ref).parent.mkdir(parents=True, exist_ok=True)
    store.path(crop_ref).write_bytes(crop)
    prepared = {"frame_ref": frame_ref, "prepared_crop_ref": crop_ref, **metadata}
    if not args.execute:
        print(json.dumps({"status": "prepared_only_no_network", **prepared}, indent=2))
        return
    report = {"recorded_at_utc": datetime.now(timezone.utc).isoformat(), "scope": "One real typed triage call on a saved physical-case replay plus one experimental grounding call on a tabletop-only crop; not a reliability benchmark.",
              "case_id": args.case, "episode_id": args.episode, "source": scenario["source"], "upload": prepared}
    for name, operation in [
        ("triage", lambda: triage_episode(scenario, result, events)),
        ("grounding", lambda: ground_objects(crop, {"chocolate_A": "red NICK'S chocolate snack packet in the lower left", "chocolate_B": "orange NICK'S chocolate snack packet in the upper left", "blue_C": "blue graze lemon flapjack packet on the right"}, frame_ref, metadata)),
    ]:
        try:
            report[name] = {"status": "response_validated", "result": await operation()}
        except (JevError, ValueError) as exc:
            report[name] = {"status": "failed_no_result", "error": str(exc)}
        store.save("jev-verification.json", report)
    print(json.dumps({"evidence": "data/jev-verification.json", "triage_status": report["triage"]["status"], "grounding_status": report["grounding"]["status"],
        "triage_ms": report["triage"].get("result", {}).get("wall_elapsed_ms"), "grounding_ms": report["grounding"].get("result", {}).get("wall_elapsed_ms")}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="data")
    parser.add_argument("--case", default="CAPTURE-5e049d873f")
    parser.add_argument("--episode", default="ep_faa3ffa41c204d06")
    parser.add_argument("--crop", nargs=4, type=int, default=[70, 20, 570, 310], metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--execute", action="store_true")
    asyncio.run(verify(parser.parse_args()))
