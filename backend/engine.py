"""Deterministic 2.5D executor. Rendering and policy code cannot set outcomes."""
from __future__ import annotations

import math
import time
from copy import deepcopy
from typing import Callable

from .kinematics import ArmConfig, KinematicsError, forward_kinematics, inverse_kinematics, joint_path

from .models import (ActionResult, Disturbance, Event, ObjectEstimate, ObservedScene,
                     PolicyAction, PolicyObservation, Robot, Scenario, SimObject, SimWorld, Zone)


def distance(a, b):
    return math.dist(a, b)


def collider_dimensions(obj):
    c, s = abs(math.cos(obj.yaw_rad)), abs(math.sin(obj.yaw_rad))
    return (c * obj.dimensions[0] + s * obj.dimensions[1],
            s * obj.dimensions[0] + c * obj.dimensions[1], obj.dimensions[2])


def segment_hits_box(a, b, zone: Zone, padding=0.015):
    """Slab intersection, including gripper clearance; no sampled-path holes."""
    low, high = 0.0, 1.0
    for i in range(3):
        margin = padding[i] if isinstance(padding, (tuple, list)) else padding
        lo = zone.center[i] - zone.size[i] / 2 - margin
        hi = zone.center[i] + zone.size[i] / 2 + margin
        delta = b[i] - a[i]
        if abs(delta) < 1e-10:
            if a[i] < lo or a[i] > hi:
                return False
        else:
            t1, t2 = sorted(((lo - a[i]) / delta, (hi - a[i]) / delta))
            low, high = max(low, t1), min(high, t2)
            if low > high:
                return False
    return True


class Environment:
    def __init__(self, episode_id: str, emit: Callable[[Event], None] | None = None):
        self.episode_id = episode_id
        self.sink = emit
        self.events: list[Event] = []
        self.terminated = False
        self.truncated = False
        self.last = ActionResult()
        self.applied: set[int] = set()
        self.live_disturbances: list[Disturbance] = []
        self.violations: list[str] = []
        self.recovery_attempts = 0
        self.halt_reason: str | None = None

    def emit(self, kind: str, data: dict):
        event = Event(kind=kind, seq=len(self.events) + 1, timestamp_ms=time.time() * 1000,
                      sim_elapsed_ms=self.world.sim_elapsed_ms, episode_id=self.episode_id,
                      session_id=self.scenario.initial_scene.session_id, data=deepcopy(data))
        self.events.append(event)
        if self.sink:
            self.sink(event)
        return event

    def reset(self, scenario: Scenario, seed: int | None = None) -> PolicyObservation:
        self.scenario = scenario.model_copy(deep=True)
        self.events = []
        self.applied = set()
        self.live_disturbances = []
        self.violations = []
        self.recovery_attempts = 0
        self.terminated = self.truncated = False
        self.halt_reason = None
        self.last = ActionResult()
        self.sensor = scenario.initial_scene.model_copy(deep=True)
        self.world = SimWorld(episode_id=self.episode_id, coordinate_frame=self.sensor.coordinate_frame,
                              workspace=self.sensor.workspace,
                              objects=[SimObject(**o.model_dump()) for o in self.sensor.objects],
                              destination=scenario.destination.model_copy(deep=True),
                              obstacles=deepcopy(scenario.obstacles), state="RUNNING")
        self.world.robot.position = (0.1 * self.world.workspace[0], 0.1 * self.world.workspace[1], 0.25)
        self.arm_config = None
        robot_config = scenario.provenance.get("robot_config", {})
        if robot_config.get("kind") == "six_dof_kinematic":
            if self.world.coordinate_frame != "workcell_m":
                raise ValueError("Six-DOF kinematics requires an explicitly metric workcell")
            self.arm_config = ArmConfig.from_dict(robot_config)
            initial = inverse_kinematics(self.arm_config.home_position, self.arm_config)
            self._set_arm_state(initial["joint_angles"])
        self.belief_objects = deepcopy(self.sensor.objects)
        self.belief_destination = deepcopy(self.world.destination)
        self.belief_obstacles = deepcopy(self.world.obstacles)
        self.observed_at_step = 0
        self.emit("episode.reset", {"case_id": scenario.case_id, "seed": scenario.seed,
                                   "initial_scene": self.sensor.model_dump()})
        self._scheduled()
        self._publish()
        return self.observation()

    def capabilities(self):
        capabilities = {"action_space": "symbolic_v1", "coordinate_frame": self.world.coordinate_frame,
                "workspace": self.world.workspace, "max_rate_hz": 5,
                "grasp_tolerance": 0.035, "safe_travel_height": 0.25,
                "max_actions": self.scenario.limits.max_actions,
                "observations": "sampled object estimates; OBSERVE refreshes; no future disturbances"}
        if self.arm_config:
            capabilities.update({"robot_config": self.arm_config.as_dict(),
                "safe_travel_height": self.arm_config.safe_travel_height,
                "max_height": self.arm_config.max_height,
                "kinematics_scope": "six revolute joints; rigid-link capsule collision checking; no contact dynamics or self-collision"})
        return capabilities

    def _set_arm_state(self, joint_angles):
        fk = forward_kinematics(joint_angles, self.arm_config)
        robot = self.world.robot
        robot.kinematics_kind = "six_dof_kinematic"
        robot.joint_angles = list(joint_angles)
        robot.joint_limits = list(self.arm_config.joint_limits)
        robot.link_positions = fk["link_positions"]
        robot.tool_rotation = fk["rotation"]
        robot.position = fk["position"]

    def observation(self):
        return PolicyObservation(episode_id=self.episode_id, step=self.world.step,
            timestamp_ms=self.world.sim_elapsed_ms, observed_at_step=self.observed_at_step,
            coordinate_frame=self.world.coordinate_frame, task=self.scenario.task,
            robot=self.world.robot.model_copy(deep=True), detected_objects=deepcopy(self.belief_objects),
            destination=deepcopy(self.belief_destination), observed_obstacles=deepcopy(self.belief_obstacles),
            last_action_result=self.last.model_copy(deep=True), workspace=self.world.workspace,
            camera_frame_ref=self.sensor.frame_ref)

    def _publish(self):
        self.world.version += 1
        self.emit("sim.state", self.world.model_dump())

    def object(self, object_id):
        return next((o for o in self.world.objects if o.id == object_id), None)

    def _scheduled(self):
        for i, disturbance in enumerate(self.scenario.disturbances):
            if i not in self.applied and disturbance.after_action_index <= self.world.step:
                self.apply_disturbance(disturbance)
                self.applied.add(i)

    def apply_disturbance(self, d: Disturbance):
        before = None
        obj = self.object(d.object_id)
        sensor = next((o for o in self.sensor.objects if o.id == d.object_id), None)
        if d.type in ("MOVE_OBJECT", "OCCLUDE_OBJECT"):
            if obj is None or obj.authority == "simulator":
                self.emit("authority.conflict", {"disturbance": d.model_dump(), "reason": "SIMULATOR_OWNS_OBJECT"})
                return
            before = obj.model_dump()
            if d.type == "MOVE_OBJECT" and d.position is not None:
                obj.position = d.position
                # A measured move also represents a visible reappearance after
                # occlusion. Replay must restore the same estimate as live sync.
                obj.visible, obj.confidence = True, d.confidence
                if sensor:
                    sensor.position = d.position
                    sensor.visible, sensor.confidence = True, d.confidence
            elif d.type == "OCCLUDE_OBJECT":
                obj.visible, obj.confidence = False, 0
                if sensor:
                    sensor.visible, sensor.confidence = False, 0
        elif d.type == "ADD_OBSTACLE" and d.obstacle:
            self.world.obstacles.append(d.obstacle.model_copy(deep=True))
        elif d.type == "MOVE_DESTINATION" and d.position:
            before = self.world.destination.model_dump()
            self.world.destination.center = d.position
        self.world.state = "DISTURBED"
        self.emit("disturbance.detected", {"disturbance": d.model_dump(), "before": before,
                                           "after": obj.model_dump() if obj else self.world.destination.model_dump()})

    def sync_observation(self, scene: ObservedScene):
        if scene.seq <= self.sensor.seq:
            return
        if scene.coordinate_frame != self.world.coordinate_frame or scene.workspace != self.world.workspace:
            self.emit("authority.conflict", {"reason": "CALIBRATION_CHANGED_DURING_EPISODE"})
            return
        for estimate in scene.objects:
            obj = self.object(estimate.id)
            if not obj:
                continue
            if obj.authority == "simulator":
                continue
            # Ignore jitter below a declared threshold; accepted state changes are replayable.
            if not estimate.visible or estimate.confidence < 0.6:
                if obj.visible:
                    d = Disturbance(type="OCCLUDE_OBJECT", object_id=obj.id,
                        after_action_index=self.world.step, source="camera_observed",
                        confidence=estimate.confidence, frame_ref=scene.frame_ref)
                    self.apply_disturbance(d)
                    self.live_disturbances.append(d)
                continue
            moved = distance(estimate.position, obj.position) >= 0.025
            if moved or not obj.visible:
                d = Disturbance(type="MOVE_OBJECT", object_id=obj.id, position=estimate.position,
                    after_action_index=self.world.step, source="camera_observed",
                    confidence=estimate.confidence, frame_ref=scene.frame_ref)
                self.apply_disturbance(d)
                self.live_disturbances.append(d)
                obj.visible, obj.confidence = True, estimate.confidence
        self.sensor = scene.model_copy(deep=True)
        self._publish()

    def step(self, action: PolicyAction):
        if self.terminated or self.truncated:
            raise RuntimeError("Episode already finished")
        self.emit("policy.action_proposed", {"action": action.model_dump(), "index": self.world.step + 1})
        result = self._execute(action)
        self.last = result
        self.world.step += 1
        self.world.sim_elapsed_ms += result.details.get("execution_ms", {"MOVE_TO": 900, "GRASP": 400, "PLACE": 400,
                                      "OBSERVE": 150, "WAIT": 250}.get(action.type, 50))
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
        if hard:
            self.violations.append(reason)
        return ActionResult(status="rejected", reason=reason, action_type=action.type, details=details)

    def _execute(self, a: PolicyAction):
        robot = self.world.robot
        ok = ActionResult(action_type=a.type)
        if a.type == "OBSERVE":
            self.belief_objects = [ObjectEstimate(**o.model_dump(exclude={"authority"}))
                if o.authority == "simulator" else next((s.model_copy(deep=True) for s in self.sensor.objects if s.id == o.id),
                    ObjectEstimate(**o.model_dump(exclude={"authority"}))) for o in self.world.objects]
            self.belief_destination = deepcopy(self.world.destination)
            self.belief_obstacles = deepcopy(self.world.obstacles)
            self.observed_at_step = self.world.step + 1
            if self.world.state == "DISTURBED" or self.last.status == "rejected":
                self.recovery_attempts += 1
                self.world.state = "RECOVERING"
            return ok
        if a.type == "MOVE_TO":
            if a.position is None:
                return self.reject(a, "INVALID_POSE")
            p = a.position
            max_height = self.arm_config.max_height if self.arm_config else .5
            if not (0 <= p[0] <= self.world.workspace[0] and 0 <= p[1] <= self.world.workspace[1] and 0 <= p[2] <= max_height):
                return self.reject(a, "OUT_OF_REACH")
            if self.arm_config:
                try:
                    ik = inverse_kinematics(p, self.arm_config, robot.joint_angles, a.orientation_rpy or (0., 0., 0.))
                    travel_ms = max(100., max(abs(q - old) for q, old in zip(ik["joint_angles"], robot.joint_angles))
                                    / self.arm_config.joint_speed_rad_s * 1000)
                    if travel_ms > a.max_execution_ms:
                        return self.reject(a, "TIMEOUT", required_execution_ms=travel_ms)
                    held = self.object(robot.holding_id) if robot.holding_id else None
                    path = joint_path(robot.joint_angles, ik["joint_angles"], self.arm_config, self.world.obstacles,
                                      carried_dimensions=collider_dimensions(held) if held else None)
                    details = {**ik, **path, "execution_ms": travel_ms}
                    self.emit("robot.kinematics_checked", {"status": "ok", **details})
                    self._set_arm_state(ik["joint_angles"])
                    if held:
                        held.position = robot.position
                    return ActionResult(action_type=a.type, details=details)
                except KinematicsError as exc:
                    self.emit("robot.kinematics_checked", {"status": "rejected", "reason": exc.reason, **exc.details})
                    return self.reject(a, exc.reason, hard=exc.reason == "ARM_COLLISION", **exc.details)
            held = self.object(robot.holding_id) if robot.holding_id else None
            padding = tuple(max(.015, x / 2) for x in collider_dimensions(held)) if held else .015
            if any(segment_hits_box(robot.position, p, z, padding) for z in self.world.obstacles):
                return self.reject(a, "PATH_OBSTRUCTED", hard=True)
            travel_ms = 900
            if travel_ms > a.max_execution_ms:
                return self.reject(a, "TIMEOUT")
            robot.position = p
            if robot.holding_id:
                self.object(robot.holding_id).position = p
            return ok
        if a.type == "GRASP":
            if robot.holding_id:
                return self.reject(a, "ALREADY_HOLDING")
            obj = self.object(a.target_id)
            if not obj:
                return self.reject(a, "UNKNOWN_OBJECT")
            if obj.id != self.scenario.task.target_id:
                return self.reject(a, "WRONG_OBJECT", hard=True)
            if not obj.visible or obj.confidence < 0.6:
                return self.reject(a, "OBJECT_NOT_VISIBLE")
            if a.position is None:
                return self.reject(a, "INVALID_POSE")
            if distance(a.position, obj.position) > 0.035:
                return self.reject(a, "TARGET_DISPLACED", distance=distance(a.position, obj.position))
            if distance(robot.position, obj.position) > 0.035:
                return self.reject(a, "GRIPPER_NOT_AT_TARGET", distance=distance(robot.position, obj.position))
            if self.world.step - self.observed_at_step > 6:
                return self.reject(a, "STALE_OBSERVATION")
            if any(segment_hits_box(robot.position, obj.position, z) for z in self.world.obstacles):
                return self.reject(a, "PATH_OBSTRUCTED", hard=True)
            robot.holding_id, robot.gripper_state = obj.id, "closed"
            obj.authority = "simulator"
            return ok
        if a.type == "PLACE":
            if robot.holding_id is None:
                return self.reject(a, "EMPTY_GRIPPER")
            if a.target_id != self.world.destination.id:
                return self.reject(a, "INVALID_DESTINATION")
            obj = self.object(robot.holding_id)
            if not inside_destination(obj, self.world.destination, robot.position):
                return self.reject(a, "DESTINATION_CHANGED")
            obj.position = robot.position
            robot.holding_id, robot.gripper_state = None, "open"
            self.emit("object.released", {"object_id": obj.id, "position": obj.position,
                                           "destination_id": self.world.destination.id})
            return ok
        if a.type == "REQUEST_HELP":
            self.terminated = True
            self.halt_reason = "REQUEST_HELP"
            self.world.state = "ESCALATED"
        elif a.type == "DONE":
            self.terminated = True
            self.halt_reason = "DONE"
        return ok


def inside_destination(obj, zone, position=None):
    p = position or obj.position
    footprint = collider_dimensions(obj)
    # Full XY footprint must fit, plus the allowed vertical drop envelope.
    return (all(abs(p[i] - zone.center[i]) + footprint[i] / 2 <= zone.size[i] / 2 + 1e-8 for i in (0, 1))
            and 0 <= p[2] <= zone.center[2] + zone.size[2] / 2)
