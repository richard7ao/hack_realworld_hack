#!/usr/bin/env python3
"""Package selected, existing FAULTLINE evidence and its exact referenced frames.

No execution is performed. Missing references are errors, and an omitted video is
recorded as absent. Identical inputs produce identical bytes and checksums.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
IDENTITY = re.compile(r"[A-Za-z0-9_-]+\Z")
FRAME_KEYS = {"frame_ref", "camera_frame_ref", "capture_frame_ref"}
SECRET = re.compile(
    rb"(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|"
    rb"Bearer\s+[A-Za-z0-9._~+-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    rb"(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|MODAL_TOKEN_SECRET)\s*[=:]\s*[^\s\"']{8,})"
)


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical_hash(value: object) -> str:
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())


def encoded(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()


def identity(value: str) -> str:
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise ValueError(f"Invalid evidence identity: {value!r}")
    return value


class Package:
    def __init__(self, data_dir: Path):
        self.data = data_dir.resolve(strict=True)
        self.files: dict[str, bytes] = {}
        self.roles: dict[str, str] = {}
        self.scenarios: dict[str, dict] = {}
        self.benchmarks: dict[str, dict] = {}
        self.episodes: dict[str, dict] = {}
        self.productions: dict[str, dict] = {}
        self.frames: set[str] = set()

    def data_path(self, relative: str) -> Path:
        pure = PurePosixPath(relative)
        if pure.is_absolute() or ".." in pure.parts or "\\" in relative:
            raise ValueError(f"Invalid evidence reference: {relative}")
        path = (self.data / relative).resolve(strict=True)
        if not path.is_relative_to(self.data) or not path.is_file():
            raise ValueError(f"Reference is not a file inside data directory: {relative}")
        return path

    def resolve(self, supplied: str, folder: str) -> Path:
        if IDENTITY.fullmatch(supplied):
            return self.data_path(f"{folder}/{supplied}.json")
        path = Path(supplied).resolve(strict=True)
        if not path.is_file() or path.suffix != ".json" or path.name.startswith("."):
            raise ValueError(f"Expected an explicit JSON evidence file: {supplied}")
        return path

    def add(self, path: str, raw: bytes, role: str) -> None:
        if any(part.startswith(".") for part in PurePosixPath(path).parts):
            raise ValueError("Hidden files and credentials cannot be packaged")
        if path in self.files and self.files[path] != raw:
            raise ValueError(f"Conflicting evidence at {path}")
        if path.endswith((".json", ".jsonl")) and SECRET.search(raw):
            raise ValueError(f"Possible credential found in {path}; packaging stopped")
        self.files[path], self.roles[path] = raw, role

    def frame_refs(self, value: object) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in FRAME_KEYS and child is not None:
                    if not isinstance(child, str):
                        raise ValueError(f"Invalid {key}")
                    parts = PurePosixPath(child).parts
                    if len(parts) != 3 or parts[0] != "frames" or not IDENTITY.fullmatch(parts[1]):
                        raise ValueError(f"Invalid frame reference: {child}")
                    if not re.fullmatch(r"[A-Za-z0-9_-]+\.(?:jpg|jpeg|png)", parts[2]):
                        raise ValueError(f"Invalid frame filename: {child}")
                    self.frames.add(child)
                else:
                    self.frame_refs(child)
        elif isinstance(value, list):
            for child in value:
                self.frame_refs(child)

    def document(self, source: Path, destination: str, role: str) -> dict:
        raw = source.read_bytes()
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError(f"Expected JSON object in {source.name}")
        self.add(destination, raw, role)
        self.frame_refs(value)
        return value

    def scenario(self, supplied: str) -> None:
        source = self.resolve(supplied, "scenarios")
        value = json.loads(source.read_bytes())
        case_id = identity(value["case_id"])
        self.document(source, f"data/scenarios/{case_id}.json", "immutable_scenario")
        if case_id in self.scenarios:
            return
        self.scenarios[case_id] = value
        capture = value.get("provenance", {}).get("capture_episode_id")
        if capture:
            self.episode(identity(capture))

    def episode(self, episode_id: str) -> None:
        identity(episode_id)
        if episode_id in self.episodes:
            return
        base = f"episodes/{episode_id}"
        result = self.document(self.data_path(f"{base}/result.json"), f"data/{base}/result.json", "episode_result")
        if result["episode_id"] != episode_id or result.get("trace_ref") != f"{base}/trace.jsonl":
            raise ValueError(f"Episode result/reference mismatch: {episode_id}")
        scenario = self.document(self.data_path(f"{base}/scenario.json"), f"data/{base}/scenario.json", "episode_scenario")
        if result["case_id"] != scenario["case_id"] or result["scenario_hash"] != canonical_hash(scenario):
            raise ValueError(f"Episode scenario hash mismatch: {episode_id}")
        trace = self.data_path(f"{base}/trace.jsonl").read_bytes()
        events = [json.loads(line) for line in trace.splitlines() if line.strip()]
        if not events or any(event.get("episode_id") != episode_id for event in events):
            raise ValueError(f"Empty or mismatched episode trace: {episode_id}")
        self.frame_refs(events)
        self.add(f"data/{base}/trace.jsonl", trace, "append_only_trace")
        self.episodes[episode_id] = result
        stored = self.data / "scenarios" / f"{scenario['case_id']}.json"
        if stored.exists():
            self.scenario(str(stored))
        for filename, role in (("captured_disturbances.json", "captured_disturbances"), ("final_world.json", "final_world")):
            path = self.data / base / filename
            if path.exists():
                raw = self.data_path(f"{base}/{filename}").read_bytes()
                self.frame_refs(json.loads(raw))
                self.add(f"data/{base}/{filename}", raw, role)

    def benchmark(self, supplied: str) -> None:
        source = self.resolve(supplied, "benchmarks")
        value = json.loads(source.read_bytes())
        bench_id = identity(value["id"])
        self.document(source, f"data/benchmarks/{bench_id}.json", "benchmark_report")
        if bench_id in self.benchmarks:
            return
        self.benchmarks[bench_id] = value
        for case in value.get("cases", []):
            self.scenario(identity(case["case_id"]))
            if canonical_hash(self.scenarios[case["case_id"]]) != case["scenario_hash"]:
                raise ValueError(f"Benchmark scenario hash mismatch: {case['case_id']}")
        for result in value.get("results", []):
            self.episode(identity(result["episode_id"]))
            if result != self.episodes[result["episode_id"]]:
                raise ValueError(f"Benchmark result differs from saved episode: {result['episode_id']}")

    def production(self, supplied: str) -> None:
        source = self.resolve(supplied, "production")
        value = json.loads(source.read_bytes())
        job_id = identity(value["job_id"])
        self.document(source, f"data/production/{job_id}.json", "production_workflow")
        if job_id in self.productions:
            return
        self.productions[job_id] = value
        for stage in value.get("stages", []):
            case_id = stage.get("case_id")
            if case_id:
                self.scenario(identity(case_id))
                if stage.get("scenario_hash") != canonical_hash(self.scenarios[case_id]):
                    raise ValueError(f"Production scenario hash mismatch: {case_id}")
            result = stage.get("result")
            if result:
                episode_id = identity(result["episode_id"])
                self.episode(episode_id)
                if result != self.episodes[episode_id]:
                    raise ValueError(f"Production result differs from saved episode: {episode_id}")
                if case_id and result["case_id"] != case_id:
                    raise ValueError(f"Production stage/result case mismatch: {case_id}")

    def finish(self, video: Path | None) -> dict:
        for relative in sorted(self.frames):
            self.add(f"data/{relative}", self.data_path(relative).read_bytes(), "referenced_camera_frame")
        video_ref = None
        if video:
            path = video.resolve(strict=True)
            if not path.is_file() or path.suffix.lower() not in {".mov", ".mp4", ".webm", ".mkv"}:
                raise ValueError("--video must name an existing video file (.mov/.mp4/.webm/.mkv)")
            video_ref = "video/demo" + path.suffix.lower()
            self.add(video_ref, path.read_bytes(), "operator_selected_video")
        scope = [
            "# FAULTLINE Pick: selected evidence", "",
            "This package copies existing local evidence. Packaging performs no new policy execution or verification.",
            "Manipulation is simulated. RGB observations estimate planar position; height and dimensions are assumptions. No hardware certification is claimed.", "",
            "## Captured and generated scenarios", "",
        ]
        for case_id, case in sorted(self.scenarios.items()):
            scope.append(f"- `{case_id}`: {case.get('name', case_id)}; source `{case.get('source')}`; {len(case.get('disturbances', []))} scheduled disturbances; SHA-256 `{canonical_hash(case)}`.")
        scope.extend(["", "## Actual episode outcomes", ""])
        for episode_id, result in sorted(self.episodes.items()):
            scope.append(f"- `{episode_id}`: case `{result['case_id']}`, policy `{result['policy']['policy_id']}`, outcome **{result['outcome']}**, reason `{result['reason']}`, evaluator `{result.get('evaluator_version')}`, verified `{result.get('verified')}`.")
        scope.extend(["", "## Actual comparison reports", ""])
        for bench_id, report in sorted(self.benchmarks.items()):
            gate = report.get("gate") or {}
            scope.append(f"- `{bench_id}`: {report.get('completed_executions', 0)}/{report.get('total_executions', 0)} executions completed; gate **{gate.get('verdict', 'not recorded')}**; reasons `{', '.join(gate.get('reasons', [])) or 'none recorded'}`; configuration `{json.dumps(gate.get('config', {}), sort_keys=True)}`.")
        if not self.benchmarks:
            scope.append("No comparison report selected.")
        scope.extend(["", f"## Production workflows ({len(self.productions)})", ""])
        for job_id, job in sorted(self.productions.items()):
            scope.append(f"- `{job_id}`: **{job.get('status', 'not recorded')}**; {job.get('completed_stages', 0)}/{job.get('total_stages', len(job.get('stages', [])))} stages completed; backend `{job.get('execution_backend', 'not recorded')}`; policy `{job.get('policy_id', 'not recorded')}`.")
            scope.append(f"  Scope: {job.get('scope', 'not recorded')}")
        if not self.productions:
            scope.append("No production workflow selected.")
        scope.extend([
            "", "## Provenance and boundaries", "",
            f"- {len(self.frames)} unique camera frames copied, selected only through explicit frame references in the selected scenarios and episode evidence. No camera-directory sweep is performed.",
            "- Capture episodes referenced by scenario provenance and episodes referenced by benchmark results are included automatically. Original live capture and fresh reruns retain distinct episode IDs.",
            "- ESCALATED means help was requested; it is not a completed placement. A BLOCK gate remains BLOCK in this package.",
            "- Source JSON and JSONL bytes are retained. SHA256SUMS and manifest.json describe their copied bytes. This checks integrity, not correctness of camera estimates or general policy reliability.",
            f"- Video: `{video_ref}`. Playback, duration, audio and screen contents require operator review." if video_ref else "- Video: absent. No final one-minute recording was supplied or created by this command.",
            "- This is an evidence package, not a submission receipt or a claim that submission is complete.", "",
        ])
        self.add("SCOPE.md", "\n".join(scope).encode(), "generated_scope")
        manifest = {
            "schema_version": "1.0", "package_type": "faultline_selected_evidence",
            "scenario_ids": sorted(self.scenarios), "benchmark_ids": sorted(self.benchmarks),
            "episode_ids": sorted(self.episodes), "production_ids": sorted(self.productions), "video": video_ref,
            "referenced_camera_frames": len(self.frames),
            "files": [{"path": path, "role": self.roles[path], "bytes": len(raw), "sha256": digest(raw)} for path, raw in sorted(self.files.items())],
        }
        self.add("manifest.json", encoded(manifest), "generated_manifest")
        checksums = "".join(f"{digest(raw)}  {path}\n" for path, raw in sorted(self.files.items()))
        self.add("SHA256SUMS", checksums.encode(), "generated_checksums")
        return manifest

    def write(self, output: Path) -> None:
        output = output.resolve()
        if output.exists():
            existing = {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob("*") if p.is_file()}
            if existing != self.files:
                raise ValueError("Output exists with different content; choose a new output directory")
            return
        output.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=".evidence-", dir=output.parent))
        try:
            for relative, raw in sorted(self.files.items()):
                path = stage / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
            stage.rename(output)
        finally:
            if stage.exists():
                shutil.rmtree(stage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", action="append", default=[], help="Saved scenario ID or JSON path; repeatable")
    parser.add_argument("--benchmark", action="append", default=[], help="Saved benchmark ID or JSON path; repeatable")
    parser.add_argument("--production", action="append", default=[], help="Saved production job ID or JSON path; repeatable")
    parser.add_argument("--episode", action="append", default=[], help="Saved episode ID; repeatable")
    parser.add_argument("--video", type=Path, help="Optional existing local video; absence is recorded")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--output", type=Path, required=True, help="New directory, or an identical previous package")
    args = parser.parse_args()
    if not (args.scenario or args.benchmark or args.episode or args.production):
        parser.error("Select at least one scenario, benchmark, episode or production workflow")
    try:
        package = Package(args.data_dir)
        for supplied in args.scenario:
            package.scenario(supplied)
        for supplied in args.benchmark:
            package.benchmark(supplied)
        for episode_id in args.episode:
            package.episode(episode_id)
        for supplied in args.production:
            package.production(supplied)
        manifest = package.finish(args.video)
        package.write(args.output)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"Evidence packaging failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"output": str(args.output.resolve()), "scenarios": manifest["scenario_ids"],
                      "benchmarks": manifest["benchmark_ids"], "episodes": manifest["episode_ids"],
                      "productions": manifest["production_ids"],
                      "referenced_camera_frames": manifest["referenced_camera_frames"],
                      "video": manifest["video"], "files": len(package.files)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
