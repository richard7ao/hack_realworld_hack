"""Optional real RoboSimStudio physics adapter, isolated from the main venv.

Only new manifests carrying execution_backend=robosimstudio_cpu dispatch here.
Unavailable or failed native execution raises explicitly; it never substitutes
the Cartesian/kinematic executor under a native label.
"""
from __future__ import annotations
import json
import math
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import uuid
import time

from .engine import Environment, distance
from .models import ActionResult, Disturbance, Limits, ObjectEstimate, ObservedScene, Scenario, Task, Zone

ROOT = Path(__file__).resolve().parents[1]
BACKEND = "robosimstudio_cpu"
SOURCE_COMMIT = "73739abe212f963e8a9f5862b27bca370df091a7"


def status():
    python = Path(os.getenv("ROBOSIM_PYTHON", str(ROOT / ".venv-robosim/bin/python")))
    source = ROOT / "third_party/robosimstudio/robosimstudio/__init__.py"
    available = python.is_file() and source.is_file()
    proof = ROOT / "data/robosim-smoke-latest.json"
    verified = False
    if proof.exists():
        try:
            verified = json.loads(proof.read_text()).get("native_physics_verified", False) is True
        except (OSError, ValueError):
            pass
    return {"available": available, "verified": verified, "engine": "RoboSimStudio/Newton/MuJoCo",
        "execution_backend": BACKEND, "device": "cpu", "source_commit": SOURCE_COMMIT,
        "reason": "Isolated native runtime ready" if available else "Run scripts/setup_robosim.sh in the project workspace",
        "scope": "Native simulated rigid-body contacts; no real robot execution or hardware certification"}


def make_robosim_cases(count=2, seed=42017):
    if not 1 <= count <= 20:
        raise ValueError("Choose 1 to 20 native physics cases")
    cases = []
    for index in range(count):
        moved = index % 2 == 1
        objects = [ObjectEstimate(id="native_cube", label="Native dynamic cube", position=(.2975, .5, .025),
            dimensions=(.05, .05, .05), source="robosimstudio_native_initial", measured_fields=[],
            assumed_fields=["declared_primitive_geometry", "mass", "friction"])]
        scene = ObservedScene(session_id="procedural_robosim", seq=0, timestamp_ms=0, coordinate_frame="workcell_m",
            sensor_mode="PROCEDURAL", camera_source="robosimstudio_native_cpu", objects=objects, workspace=(.595, 1.3))
        disturbances = [Disturbance(type="MOVE_OBJECT", object_id="native_cube", after_action_index=1,
            position=(.3775, .5, .025), source="procedural")] if moved else []
        cases.append(Scenario(case_id=f"ROBOSIM-{'displacement' if moved else 'clean'}-{seed + index}",
            name=f"RoboSimStudio actual YAM CPU physics · {'displacement' if moved else 'clean pick'} · {seed + index}",
            source="procedural", family="robosim_displacement" if moved else "robosim_clean", seed=seed + index,
            task=Task(target_id="native_cube"), initial_scene=scene,
            destination=Zone(center=(.4175, .5, .025), size=(.16, .16, .15)), disturbances=disturbances,
            limits=Limits(max_actions=24, max_sim_seconds=120),
            provenance={"execution_backend": BACKEND, "source_commit": SOURCE_COMMIT,
                "native_robot": "yam_i2rt", "active_arm": "right", "idle_arm": "left",
                "cell": "bench_075", "native_surface_origin": [.6, 0, .75],
                "note": "Procedural actual native contact physics; source YAM model and gripper. No camera, attachment constraint or hardware claim."}))
    return cases


class NativeWorker:
    def __init__(self, realtime=False):
        if not status()["available"]:
            raise ValueError(status()["reason"])
        self.log = tempfile.TemporaryFile(mode="w+")
        env = os.environ.copy()
        for credential in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JEV_API_KEY", "TYPESAFE_API_KEY", "HYPER3D_API_KEY"):
            env.pop(credential, None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["ROBOSIM_REALTIME"] = "1" if realtime else "0"
        self.on_sample = None
        self._buffer = b""
        env["PATH"] = "/Library/Developer/CommandLineTools/usr/bin:" + env.get("PATH", "")
        self.process = subprocess.Popen([os.getenv("ROBOSIM_PYTHON", str(ROOT / ".venv-robosim/bin/python")),
            str(ROOT / "backend/robosim_worker.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.log, bufsize=0, env=env, cwd=ROOT)

    def request(self, payload, timeout=180):
        self.process.stdin.write((json.dumps(payload, allow_nan=False) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while True:
                while b"\n" not in self._buffer:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        self.close()
                        raise TimeoutError("RoboSimStudio native worker timed out")
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk:
                        self.log.seek(0)
                        raise RuntimeError("RoboSimStudio worker exited: " + self.log.read()[-1500:])
                    self._buffer += chunk
                line, self._buffer = self._buffer.split(b"\n", 1)
                result = json.loads(line)
                if result.get("in_progress"):
                    if self.on_sample:
                        self.on_sample(result)
                    continue
                if not result.get("ok"):
                    raise RuntimeError(f"RoboSimStudio {result.get('error_type')}: {result.get('error')}")
                return result

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write(b'{"op":"close"}\n')
                self.process.stdin.flush()
                self.process.wait(timeout=3)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
        for stream in [self.process.stdin, self.process.stdout, self.log]:
            if stream:
                stream.close()


class RoboSimEnvironment(Environment):
    def __init__(self, episode_id, emit=None):
        super().__init__(episode_id, emit)
        self.worker = None
        self._ready = False
        self._deferred = []

    def _publish(self):
        if self._ready:
            super()._publish()

    def reset(self, scenario, seed=None):
        self.close()
        self._ready, self._deferred = False, []
        if scenario.provenance.get("execution_backend") != BACKEND or scenario.initial_scene.coordinate_frame != "workcell_m":
            raise ValueError("Native physics requires its own explicit metric scenario manifest")
        super().reset(scenario, seed)
        self.worker = NativeWorker(realtime=getattr(self, "realtime", False))
        result = self.worker.request({"op": "init", "scenario": scenario.model_dump(mode="json")})
        self._ready = True
        self.native_start_time = result["state"]["sim_time"]
        self.worker.on_sample = self._sample
        self._native_state(result)
        self.emit("physics.initialized", {"backend": BACKEND, "source_commit": SOURCE_COMMIT,
            "native_physics": self.world.robot.native_physics, "attachment_constraints": False,
            "capabilities": self.capabilities(), "sample_interval_sim_ms": 100,
            "realtime_pacing": getattr(self, "realtime", False)})
        for disturbance in self._deferred:
            self.apply_disturbance(disturbance)
        self._deferred = []
        self._publish()
        return self.observation()

    def capabilities(self):
        result = super().capabilities()
        result.update({"execution_backend": BACKEND, "safe_travel_height": .10, "max_height": .45,
            "robot_model": "yam_i2rt", "orientation_control": "fixed downward source YAM grasp-site quaternion", "active_arm": "right", "idle_arm": "left",
            "observations": "sampled native object poses and measured robot proprioception; OBSERVE refreshes",
            "grasp_validation": "bilateral native fingertip contact plus actual dynamic lift; no attachment constraint"})
        return result

    def _sample(self, result):
        self._native_state(result)
        self._publish()

    def _native_state(self, result):
        state = result["state"]
        if not state["finite"]:
            raise RuntimeError("Native physics returned a nonfinite state")
        for obj in state["objects"]:
            world_obj = self.object(obj["id"])
            world_obj.position = tuple(obj["position"])
            world_obj.orientation_quaternion = tuple(obj["quaternion"])
            world_obj.authority = "simulator"
            sensor = next(o for o in self.sensor.objects if o.id == obj["id"])
            sensor.position = tuple(obj["position"])
        native, robot = state["robot"], self.world.robot
        for field in ["position", "joint_angles", "joint_limits", "link_positions", "holding_id", "mesh_poses", "native_contacts", "native_physics"]:
            setattr(robot, field, tuple(native[field]) if field == "position" else
                    [tuple(p) for p in native[field]] if field in ("link_positions", "joint_limits") else native[field])
        robot.kinematics_kind, robot.visual_model_id = "robosim_physics", "yam_i2rt"
        robot.gripper_state = "closed" if robot.holding_id or native["native_physics"]["jaw_closed_fraction"] > .5 else "open"
        if hasattr(self, "native_start_time"):
            self.world.sim_elapsed_ms = max(0., (state["sim_time"] - self.native_start_time) * 1000)
        self.native_snapshot = state

    def step(self, action):
        # The native solver is the only simulation clock. Inherited Cartesian
        # execution adds nominal durations, which would double-count streamed
        # native samples and move event timestamps backwards at action end.
        if self.terminated or self.truncated:
            raise RuntimeError("Episode already finished")
        self.emit("policy.action_proposed", {"action": action.model_dump(), "index": self.world.step + 1})
        result = self._execute(action)
        self.last = result
        self.world.step += 1
        self.emit("executor.action_result", {"action": action.model_dump(), "result": result.model_dump(),
                                             "index": self.world.step})
        self._scheduled()
        if self.world.step >= self.scenario.limits.max_actions or self.world.sim_elapsed_ms > self.scenario.limits.max_sim_seconds * 1000:
            self.truncated = True
            self.halt_reason = "ACTION_BUDGET" if self.world.step >= self.scenario.limits.max_actions else "SIM_TIME_BUDGET"
            self.world.state = "TIMEOUT"
        self._publish()
        return {"observation": self.observation(), "reward_or_score": 0,
                "terminated": self.terminated, "truncated": self.truncated, "info": result}

    def reject(self, action, reason, hard=False, **details):
        details.setdefault("execution_ms", 0.)
        return super().reject(action, reason, hard, **details)

    def _execute(self, action):
        if action.type in ("OBSERVE", "DONE", "REQUEST_HELP"):
            result = super()._execute(action)
            result.details["execution_ms"] = 0.
            return result
        robot = self.world.robot
        if action.orientation_rpy is not None and any(abs(v) > 1e-8 for v in action.orientation_rpy):
            return self.reject(action, "UNSUPPORTED_NATIVE_ORIENTATION")
        if action.type == "GRASP":
            obj = self.object(action.target_id)
            if robot.holding_id:
                return self.reject(action, "ALREADY_HOLDING")
            if not obj:
                return self.reject(action, "UNKNOWN_OBJECT")
            if obj.id != self.scenario.task.target_id:
                return self.reject(action, "WRONG_OBJECT", hard=True)
            if action.position is None:
                return self.reject(action, "INVALID_POSE")
            if distance(action.position, obj.position) > .035:
                return self.reject(action, "TARGET_DISPLACED", distance=distance(action.position, obj.position))
            if distance(robot.position, obj.position) > .05:
                return self.reject(action, "GRIPPER_NOT_AT_TARGET")
            request = {"op": "grasp", "target_id": obj.id}
        elif action.type == "MOVE_TO":
            if action.position is None:
                return self.reject(action, "INVALID_POSE")
            x, y, z = action.position
            if not (0 <= x <= self.world.workspace[0] and 0 <= y <= self.world.workspace[1] and 0 <= z <= .45):
                return self.reject(action, "OUT_OF_REACH")
            request = {"op": "move", "position": action.position}
        elif action.type == "PLACE":
            if not robot.holding_id:
                return self.reject(action, "EMPTY_GRIPPER")
            if action.target_id != self.world.destination.id:
                return self.reject(action, "INVALID_DESTINATION")
            request = {"op": "place"}
        else:
            request = {"op": "wait", "steps": 10}
        request["max_execution_ms"] = action.max_execution_ms
        result = self.worker.request(request)
        self._native_state(result)
        details = {**result["details"], "execution_ms": result["execution_ms"],
                   "native_physics": robot.native_physics, "native_contacts": robot.native_contacts}
        self.emit("physics.action_executed", {"action_type": action.type, **details})
        if not details["ok"]:
            return self.reject(action, details["reason"], hard=details["reason"] == "NATIVE_OBSTACLE_CONTACT",
                               **{key: value for key, value in details.items() if key != "reason"})
        if action.type == "PLACE":
            released = details["released_id"]
            self.emit("object.released", {"object_id": released, "position": self.object(released).position,
                "destination_id": action.target_id, "native_open_and_settle_verified": True})
        return ActionResult(action_type=action.type, details=details)

    def apply_disturbance(self, disturbance):
        if not self._ready:
            self._deferred.append(disturbance)
            return
        if disturbance.type != "MOVE_OBJECT" or disturbance.position is None:
            raise ValueError("Native physics currently supports explicit scheduled object displacement only")
        if self.world.robot.holding_id == disturbance.object_id:
            self.emit("authority.conflict", {"reason": "NATIVE_CONTACT_OWNS_GRASPED_OBJECT"})
            return
        before = self.object(disturbance.object_id).model_dump()
        result = self.worker.request({"op": "disturb", "target_id": disturbance.object_id, "position": disturbance.position})
        self._native_state(result)
        self.world.state = "DISTURBED"
        self.emit("disturbance.detected", {"disturbance": disturbance.model_dump(), "before": before,
            "after": self.object(disturbance.object_id).model_dump(), "native_state_edit": "explicit scheduled disturbance, not a grasp constraint"})

    def sync_observation(self, scene):
        self.emit("authority.conflict", {"reason": "NATIVE_PHYSICS_RERUN_ISOLATED_FROM_CAMERA"})

    def close(self):
        if self.worker is not None:
            self.worker.close()
            self.worker = None


def environment_for(scenario, episode_id, emit=None):
    return RoboSimEnvironment(episode_id, emit) if scenario.provenance.get("execution_backend") == BACKEND else Environment(episode_id, emit)
