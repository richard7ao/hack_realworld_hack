"""Isolated JSON-lines worker for unchanged RoboSimStudio + Newton/MuJoCo CPU.

Run only with .venv-robosim Python. Standard output is exclusively the protocol;
upstream Python AND native C/C++ diagnostics are redirected to standard error.
No grasp attachment, object-follow constraint, or command-derived success exists.
"""
from __future__ import annotations
import contextlib
import json
import math
import os
from pathlib import Path
import sys
import traceback
import time
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
source_file = ROOT / ".venv-robosim/robosim-source.txt"
SOURCE = Path(os.getenv("ROBOSIM_SOURCE", source_file.read_text().strip() if source_file.exists()
                       else str(ROOT / "third_party/robosimstudio")))
sys.path.insert(0, str(SOURCE))
os.environ.setdefault("JAX_PLATFORMS", "cpu")
os.environ.setdefault("JAX_COMPILATION_CACHE_DIR", "/private/tmp/faultline-jax-cache")
os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("XDG_CACHE_HOME", "/private/tmp/faultline-native-cache")


class NativeActionBudget(RuntimeError):
    pass


class NativeSimulation:
    def __init__(self, scenario):
        import numpy as np
        import warp as wp
        wp.config.kernel_cache_dir = "/private/tmp/faultline-warp-cache"
        import robosimstudio as rss
        from robosimstudio.robots.embodiments.yam_i2rt import grasp_site_quat
        self.np, self.wp, self.rss = np, wp, rss
        self.grasp_quaternion = grasp_site_quat
        self.scenario = scenario
        self.workspace = scenario["initial_scene"]["workspace"]
        self.origin = np.array([.6, 0., .75])  # bench_075 declared surface frame.
        self.holding = None
        self.grip_command = 0.
        self.last_motion = {}
        self.action_deadline = None
        self.sample_callback = None
        self.control_steps = 0
        self.realtime = os.getenv("ROBOSIM_REALTIME") == "1"
        physics = rss.MUJOCO_500HZ.with_backend("*", rss.backend("mujoco", use_mujoco_cpu=True,
            nconmax=512, njmax=512, enable_multiccd=True))
        scene = rss.Scene(cell="bench_075", physics=physics)
        self.refs = {}
        for obj in scenario["initial_scene"]["objects"]:
            p = obj["position"]
            self.refs[obj["id"]] = scene.add(rss.box(name=obj["id"],
                half=tuple(d / 2 for d in obj["dimensions"]), at=self.to_surface(p),
                mass=.05, friction=1.0))
        self.obstacle_names = set()
        for obstacle in scenario.get("obstacles", []):
            self.obstacle_names.add(obstacle["id"])
            scene.add(rss.slab(name=obstacle["id"], half=tuple(d / 2 for d in obstacle["size"]),
                               at=self.to_surface(obstacle["center"])))
        scene.add(rss.robot("yam_i2rt"))
        self.sim = scene.build(device="cpu", use_cuda_graph=False, control_mode="joint_position")
        self.right, self.left = self.sim.arm("right"), self.sim.arm("left")
        self.idle_q = self.sim.state.joint_q.numpy()[self.left.arm_coords].copy()
        self.initial_objects = [{"id": name, "position": self.to_logical(ref.position)}
                                for name, ref in self.refs.items()]
        self.sim.run(50).sync()
        self.geom_specs = self._geom_specs()

    def to_surface(self, position):
        return (position[0] - self.workspace[0] / 2, position[1] - self.workspace[1] / 2, position[2])

    def to_native(self, position):
        return self.np.asarray(self.to_surface(position)) + self.origin

    def to_logical(self, position):
        p = self.np.asarray(position) - self.origin
        return [float(p[0] + self.workspace[0] / 2), float(p[1] + self.workspace[1] / 2), float(p[2])]

    def _geom_specs(self):
        path = SOURCE / "assets/embodiments/yam_i2rt/yam_i2rt_arms.xml"
        root = ET.parse(path).getroot()
        result = []
        for body in root.findall(".//body"):
            for index, geom in enumerate(body.findall("geom")):
                mesh = geom.get("mesh")
                if not mesh:
                    continue
                position = [float(v) for v in geom.get("pos", "0 0 0").split()]
                w, x, y, z = [float(v) for v in geom.get("quat", "1 0 0 0").split()]
                result.append((body.get("name"), index, mesh + ".stl", position, [x, y, z, w]))
        return result

    def contacts(self):
        import mujoco
        solver = self.sim.scene.program.mujoco_solver
        model, data = solver.mj_model, solver.mj_data
        mapping = solver.mjc_geom_to_newton_shape.numpy()
        if mapping.ndim == 2:
            mapping = mapping[0]
        shape_body = self.sim.model.shape_body.numpy()
        labels = self.sim.model.body_label
        rows = []
        for index in range(int(data.ncon)):
            contact = data.contact[index]
            names = []
            for geom in [contact.geom1, contact.geom2]:
                shape = int(mapping[int(geom)])
                body = int(shape_body[shape]) if shape >= 0 else -1
                names.append(str(labels[body]) if body >= 0 else
                    str(self.sim.model.shape_label[shape]) if shape >= 0 else "static")
            force = self.np.zeros(6)
            mujoco.mj_contactForce(model, data, index, force)
            rows.append({"body_a": names[0], "body_b": names[1], "distance_m": float(contact.dist),
                         "normal_force_n": float(force[0])})
        return rows

    def _touching_sides(self, target):
        sides = set()
        for row in self.contacts():
            a, b = row["body_a"], row["body_b"]
            if target in (a.split("/")[-1], b.split("/")[-1]):
                other = b if a.split("/")[-1] == target else a
                if row["normal_force_n"] > .001:
                    if "right_tip_left" in other:
                        sides.add("left")
                    if "right_tip_right" in other:
                        sides.add("right")
        return sorted(sides)

    def _action(self, right_q, grip):
        return self.np.concatenate([right_q, [grip], self.idle_q, [0.]]).astype(self.np.float32)

    def _advance(self, right_q, grip, steps):
        collisions = []
        action = self._action(right_q, grip)
        for _ in range(steps):
            step_wall_start = time.monotonic()
            if self.action_deadline is not None and self.sim.time + .02 > self.action_deadline + 1e-9:
                raise NativeActionBudget("Native action exhausted its actual simulator-time budget")
            self.sim.step(action, mode="joint_position")
            for row in self.contacts():
                names = row["body_a"] + " " + row["body_b"]
                if row["normal_force_n"] > .2 and "right_" in names and any(name in names for name in self.obstacle_names):
                    collisions.append(row)
            if not self.sim.state_is_finite():
                raise RuntimeError("NONFINITE_NATIVE_STATE")
            self.control_steps += 1
            if self.sample_callback and self.control_steps % 5 == 0:
                self.sample_callback({"state": self.state(), "sample_control_step": self.control_steps})
            if self.realtime:
                time.sleep(max(0., .02 - (time.monotonic() - step_wall_start)))
        self.sim.sync()
        return collisions

    def _move(self, logical, *, descend=True):
        requested = self.to_native(logical)
        current_p, _ = self.right.ee_pose(self.sim.state)
        points = []
        if descend and not self.holding and logical[2] < .10 and math.dist(current_p[:2], requested[:2]) > .04:
            points.append(requested + self.np.array([0., 0., .14]))
        points.append(requested)
        evidence = []
        collisions = []
        for point in points:
            seed = self.sim.state.joint_q.numpy().copy()
            quat = self.grasp_quaternion(0.)
            with self.right.host_fk():
                solved = self.right.solve_q_full(seed, point, quat)
                predicted, predicted_q = self.right.fk_ee(solved)
            residual = float(self.np.linalg.norm(predicted - point))
            orientation_residual = 2 * math.acos(min(1., abs(float(self.np.dot(predicted_q, quat)))))
            if residual > .015:
                return {"ok": False, "reason": "NATIVE_IK_UNREACHABLE", "ik_residual_m": residual,
                        "target_native": point.tolist(), "waypoints": evidence}
            start, goal = seed[self.right.arm_coords], solved[self.right.arm_coords]
            lower = self.sim.model.joint_limit_lower.numpy()[self.right.arm_dofs]
            upper = self.sim.model.joint_limit_upper.numpy()[self.right.arm_dofs]
            if self.np.any(goal < lower - .001) or self.np.any(goal > upper + .001):
                return {"ok": False, "reason": "NATIVE_JOINT_LIMIT", "requested_joint_angles": goal.tolist(),
                    "joint_limits": self.np.column_stack([lower, upper]).tolist()}
            steps = max(25, min(100, math.ceil(float(self.np.max(self.np.abs(goal - start))) / .035)))
            for index in range(1, steps + 1):
                q = start + (goal - start) * index / steps
                collisions += self._advance(q, self.grip_command, 1)
            collisions += self._advance(goal, self.grip_command, 20)
            actual_p, actual_q = self.right.ee_pose(self.sim.state)
            actual_residual = float(self.np.linalg.norm(actual_p - point))
            evidence.append({"target_native": point.tolist(), "ik_residual_m": residual,
                "ik_orientation_residual_rad": orientation_residual, "actual_tcp_residual_m": actual_residual, "control_steps": steps + 20,
                "actual_joint_angles": self.sim.state.joint_q.numpy()[self.right.arm_coords].tolist()})
        self.last_motion = {"waypoints": evidence, "forbidden_contacts": collisions,
                            "native_control_mode": "joint_position", "native_action_dimension": 14}
        return {"ok": not collisions and evidence[-1]["actual_tcp_residual_m"] < .035,
                "reason": "NATIVE_OBSTACLE_CONTACT" if collisions else "OK" if evidence[-1]["actual_tcp_residual_m"] < .035 else "NATIVE_TRACKING_ERROR",
                **self.last_motion}

    def command(self, request):
        start_time = self.sim.time
        self.action_deadline = start_time + request.get("max_execution_ms", 10000) / 1000
        try:
            return self._command(request)
        except NativeActionBudget:
            return {"state": self.state(), "details": {"ok": False, "reason": "TIMEOUT",
                "budget_ms": request.get("max_execution_ms", 10000), "partial_native_execution": True},
                "execution_ms": (self.sim.time - start_time) * 1000}
        finally:
            self.action_deadline = None

    def _command(self, request):
        op = request["op"]
        start_time = self.sim.time
        details = {"ok": True, "reason": "OK"}
        if op == "move":
            details = self._move(request["position"])
        elif op == "grasp":
            target = request["target_id"]
            before = self.refs[target].position.copy()
            self.grip_command = 1.
            q = self.sim.state.joint_q.numpy()[self.right.arm_coords]
            self._advance(q, self.grip_command, 40)
            touch = self._touching_sides(target)
            measured_closed = float(self.sim.gripper("right").closed_fraction(self.sim.state))
            grasp_verified = False
            lifted = 0.
            if len(touch) == 2:
                position, _ = self.right.ee_pose(self.sim.state)
                logical = self.to_logical(position + self.np.array([0., 0., .06]))
                motion = self._move(logical, descend=False)
                lifted = float(self.refs[target].position[2] - before[2])
                grasp_verified = motion["ok"] and lifted >= .025 and len(self._touching_sides(target)) == 2
            self.holding = target if grasp_verified else None
            details = {"ok": grasp_verified, "reason": "OK" if grasp_verified else "NATIVE_GRASP_NOT_VERIFIED",
                "touching_finger_sides": touch, "measured_closed_fraction": measured_closed,
                "actual_lift_m": lifted, "grasp_verified": grasp_verified,
                "validation": "bilateral native contacts plus actual dynamic object lift; no attachment constraint"}
        elif op == "place":
            released = self.holding
            self.grip_command = 0.
            q = self.sim.state.joint_q.numpy()[self.right.arm_coords]
            self._advance(q, 0., 40)
            self.holding = None
            p, _ = self.right.ee_pose(self.sim.state)
            retract = self._move(self.to_logical(p + self.np.array([0., 0., .13])), descend=False)
            q = self.sim.state.joint_q.numpy()[self.right.arm_coords]
            self._advance(q, 0., 35)
            speed = float(self.np.linalg.norm(self.refs[released].velocity[:3])) if released else None
            details = {"ok": released is not None and speed < .03, "reason": "OK" if released is not None and speed < .03 else "NATIVE_RELEASE_NOT_SETTLED",
                "released_id": released, "actual_object_speed_m_s": speed, "retract_motion": retract}
        elif op == "wait":
            q = self.sim.state.joint_q.numpy()[self.right.arm_coords]
            self._advance(q, self.grip_command, int(request.get("steps", 10)))
        elif op == "disturb":
            import newton
            target = request["target_id"]
            entity = self.sim.scene.objects[target]
            body = int(entity.body)
            joint = int(self.np.flatnonzero(self.sim.model.joint_child.numpy() == body)[0])
            dof = int(self.sim.model.joint_qd_start.numpy()[joint])
            pose = [*self.to_native(request["position"]), 0., 0., 0., 1.]
            for state in [self.sim.pipeline.state_0, self.sim.pipeline.state_1]:
                q, qd = state.joint_q.numpy().copy(), state.joint_qd.numpy().copy()
                q[entity.coord_start:entity.coord_start + 7] = pose
                qd[dof:dof + 6] = 0
                state.joint_q.assign(q)
                state.joint_qd.assign(qd)
                newton.eval_fk(self.sim.model, state.joint_q, state.joint_qd, state)
            self.sim.pipeline.reset_solvers()
            self.sim.sync()
            details = {"ok": True, "reason": "EXPLICIT_SCHEDULED_DISTURBANCE"}
        elif op != "state":
            raise ValueError("Unsupported native command")
        return {"state": self.state(), "details": details, "execution_ms": (self.sim.time - start_time) * 1000}

    def state(self):
        import mujoco, newton
        from robosimstudio.core.math import quat_to_mat, quat_multiply
        self.sim.sync()
        native_q = self.sim.state.body_q.numpy()
        labels = {str(label).split("/")[-1]: index for index, label in enumerate(self.sim.model.body_label)}
        meshes = []
        for name, index, mesh, offset, quat in self.geom_specs:
            if name not in labels:
                continue
            body = native_q[labels[name]]
            position = body[:3] + quat_to_mat(body[3:7]) @ self.np.asarray(offset)
            rotation = quat_multiply(body[3:7], self.np.asarray(quat))
            meshes.append({"name": f"{name}:{index}", "mesh": mesh,
                           "position": self.to_logical(position), "quaternion": rotation.tolist()})
        tcp, quat = self.right.ee_pose(self.sim.state)
        q = self.sim.state.joint_q.numpy()
        contacts = self.contacts()
        if self.holding and len(self._touching_sides(self.holding)) < 2:
            self.holding = None
        return {"objects": [{"id": name, "position": self.to_logical(ref.position),
                   "quaternion": self.np.asarray(ref.pose[3:7]).tolist(), "velocity": self.np.asarray(ref.velocity).tolist()} for name, ref in self.refs.items()],
            "robot": {"position": self.to_logical(tcp), "quaternion": quat.tolist(),
                "joint_angles": q[self.right.arm_coords].tolist(),
                "joint_limits": self.np.column_stack([
                    self.sim.model.joint_limit_lower.numpy()[self.right.arm_dofs],
                    self.sim.model.joint_limit_upper.numpy()[self.right.arm_dofs]]).tolist(),
                "link_positions": [self.to_logical(native_q[labels[name]][:3]) for name in
                    ["right_base", "right_link1", "right_link2", "right_link3", "right_link4", "right_link5", "right_link6", "right_gripper"] if name in labels] + [self.to_logical(tcp)],
                "holding_id": self.holding, "mesh_poses": meshes,
                "native_contacts": contacts,
                "native_physics": {"engine": "RoboSimStudio/Newton/MuJoCo", "device": "cpu",
                    "robosimstudio_version": self.rss.__version__, "newton_version": newton.__version__,
                    "mujoco_version": mujoco.__version__, "sim_time": self.sim.time,
                    "initial_objects": self.initial_objects, "contact_count": len(contacts), "jaw_closed_fraction": float(self.sim.gripper("right").closed_fraction(self.sim.state)),
                    "jaw_joint_positions_m": q[self.sim.scene.embodiment.arms["right"].gripper_coords].tolist(),
                    "tcp_quaternion_xyzw": quat.tolist(), "active_arm": "right", "idle_arm": "left", "source_commit": "73739abe212f963e8a9f5862b27bca370df091a7"}},
            "sim_time": self.sim.time, "finite": bool(self.sim.state_is_finite())}


def main():
    protocol = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    simulation = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request["op"] == "close":
                return
            if request["op"] == "init":
                simulation = NativeSimulation(request["scenario"])
                simulation.sample_callback = lambda sample: os.write(protocol,
                    (json.dumps({"ok": True, "in_progress": True, **sample}, allow_nan=False) + "\n").encode())
                response = {"state": simulation.state(), "details": {"ok": True}, "execution_ms": 0}
            elif simulation is None:
                raise ValueError("Initialize the native scene first")
            else:
                response = simulation.command(request)
            output = {"ok": True, **response}
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            output = {"ok": False, "error_type": type(exc).__name__, "error": str(exc)[:1000]}
        os.write(protocol, (json.dumps(output, allow_nan=False) + "\n").encode())


if __name__ == "__main__":
    main()
