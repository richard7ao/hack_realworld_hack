"""Local evidence, atomic documents and append-only episode traces."""
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from .models import Event, Scenario


def canonical_hash(value):
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class Storage:
    def __init__(self, root="data"):
        self.root = Path(root)
        for folder in ("scenarios", "episodes", "frames", "benchmarks"):
            (self.root / folder).mkdir(parents=True, exist_ok=True)

    def path(self, relative):
        p = (self.root / relative).resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError("Invalid storage path")
        return p

    def save(self, relative, data):
        p = self.path(relative)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Concurrent policy episodes may save the same immutable scenario.
        # Each writer needs its own temporary file before the atomic replace.
        with tempfile.NamedTemporaryFile(mode="w", dir=p.parent, prefix=p.name + ".", suffix=".tmp", delete=False) as handle:
            temp = Path(handle.name)
            handle.write(json.dumps(data, indent=2, allow_nan=False) + "\n")
        try:
            os.replace(temp, p)
        finally:
            temp.unlink(missing_ok=True)

    def load(self, relative):
        return json.loads(self.path(relative).read_text())

    def append_event(self, event: Event):
        if not event.episode_id or not re.fullmatch(r"[a-zA-Z0-9_-]+", event.episode_id):
            raise ValueError("Invalid episode identity")
        p = self.path(f"episodes/{event.episode_id}/trace.jsonl")
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as f:
            f.write(event.model_dump_json() + "\n")
            f.flush()

    def save_scenario(self, scenario: Scenario):
        relative = f"scenarios/{scenario.case_id}.json"
        p = self.path(relative)
        if p.exists() and canonical_hash(self.load(relative)) != canonical_hash(scenario):
            raise ValueError("Immutable scenario ID already exists with different content")
        self.save(relative, scenario.model_dump(mode="json"))
        return canonical_hash(scenario)

    def scenarios(self):
        return [json.loads(p.read_text()) for p in sorted(self.path("scenarios").glob("*.json"))]
