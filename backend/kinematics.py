"""Deterministic six-revolute-joint rigid-chain kinematics, without dynamics.

Chain: Rz(q0), Ry(q1), Tx(upper), Ry(q2), Tx(forearm),
Ry(q3), Rx(q4), Rz(q5), Tx(tool). Three wrist axes intersect.
IK analytically solves both elbow branches for a declared tool orientation.
Collision checks conservatively inflate link capsules by an interpolation
displacement bound; they do not simulate contacts, torque or self-collision.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np


class KinematicsError(ValueError):
    def __init__(self, reason: str, **details):
        super().__init__(reason)
        self.reason, self.details = reason, details


@dataclass(frozen=True)
class ArmConfig:
    base_position: tuple[float, float, float] = (2., 1.5, .65)
    upper_arm: float = 1.25
    forearm: float = 1.25
    tool_length: float = .12
    joint_limits: tuple[tuple[float, float], ...] = ((-math.pi, math.pi),) * 6
    collision_radius: float = .025
    interpolation_resolution_m: float = .02
    joint_speed_rad_s: float = 2.5
    safe_travel_height: float = 1.35
    max_height: float = 2.4
    home_position: tuple[float, float, float] = (2.7, 1.5, 1.1)

    @classmethod
    def from_dict(cls, value: dict[str, Any]):
        allowed = set(cls.__dataclass_fields__)
        unknown = set(value) - allowed - {"kind"}
        if unknown:
            raise ValueError(f"Unknown arm configuration fields: {sorted(unknown)}")
        data = {k: v for k, v in value.items() if k in allowed}
        for key in ("base_position", "home_position"):
            if key in data:
                data[key] = tuple(data[key])
        if "joint_limits" in data:
            data["joint_limits"] = tuple(tuple(pair) for pair in data["joint_limits"])
        result = cls(**data)
        scalars = [result.upper_arm, result.forearm, result.tool_length, result.collision_radius,
                   result.interpolation_resolution_m, result.joint_speed_rad_s, result.max_height,
                   result.safe_travel_height]
        if any(not math.isfinite(x) or x <= 0 for x in scalars):
            raise ValueError("Arm lengths, radii, resolution and speed must be finite and positive")
        if len(result.joint_limits) != 6 or any(len(pair) != 2 or not all(math.isfinite(x) for x in pair)
                or pair[0] >= pair[1] for pair in result.joint_limits):
            raise ValueError("Exactly six finite, increasing joint limits are required")
        if any(len(p) != 3 or not all(math.isfinite(x) for x in p) for p in [result.base_position, result.home_position]):
            raise ValueError("Arm base and home must be finite XYZ positions")
        return result

    def as_dict(self):
        return {"kind": "six_dof_kinematic", **{name: getattr(self, name) for name in self.__dataclass_fields__}}


def _rotation(axis, angle):
    c, s = math.cos(angle), math.sin(angle)
    if axis == "x":
        return np.array([[1., 0, 0], [0, c, -s], [0, s, c]])
    if axis == "y":
        return np.array([[c, 0, s], [0, 1., 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.]])


def rpy_matrix(rpy):
    roll, pitch, yaw = rpy
    return _rotation("z", yaw) @ _rotation("y", pitch) @ _rotation("x", roll)


def forward_kinematics(joint_angles, config: ArmConfig):
    if len(joint_angles) != 6 or not all(math.isfinite(x) for x in joint_angles):
        raise KinematicsError("INVALID_JOINT_STATE")
    q = joint_angles
    p = np.array(config.base_position, dtype=float)
    links = [(p[0], p[1], 0.), tuple(p)]
    rotation = _rotation("z", q[0]) @ _rotation("y", q[1])
    p = p + rotation @ np.array([config.upper_arm, 0, 0])
    links.append(tuple(float(x) for x in p))
    rotation = rotation @ _rotation("y", q[2])
    p = p + rotation @ np.array([config.forearm, 0, 0])
    links.extend([tuple(float(x) for x in p)] * 3)
    rotation = rotation @ _rotation("y", q[3]) @ _rotation("x", q[4]) @ _rotation("z", q[5])
    p = p + rotation @ np.array([config.tool_length, 0, 0])
    links.append(tuple(float(x) for x in p))
    return {"position": tuple(float(x) for x in p), "rotation": rotation.tolist(), "link_positions": links}


def inverse_kinematics(position, config: ArmConfig, current=None, orientation_rpy=(0., 0., 0.)):
    if len(position) != 3 or not all(math.isfinite(x) for x in position):
        raise KinematicsError("INVALID_POSE")
    desired = rpy_matrix(orientation_rpy)
    wrist = np.asarray(position) - desired @ np.array([config.tool_length, 0, 0]) - np.asarray(config.base_position)
    radial = math.hypot(wrist[0], wrist[1])
    cosine = (float(wrist @ wrist) - config.upper_arm ** 2 - config.forearm ** 2) / (2 * config.upper_arm * config.forearm)
    if cosine < -1 - 1e-9 or cosine > 1 + 1e-9:
        raise KinematicsError("UNREACHABLE", wrist_distance_m=float(np.linalg.norm(wrist)),
                              maximum_reach_m=config.upper_arm + config.forearm)
    q0 = math.atan2(wrist[1], wrist[0])
    candidates = []
    for elbow in [math.acos(max(-1., min(1., cosine))), -math.acos(max(-1., min(1., cosine)))]:
        shoulder = math.atan2(-wrist[2], radial) - math.atan2(config.forearm * math.sin(elbow),
                       config.upper_arm + config.forearm * math.cos(elbow))
        wrist_rotation = (_rotation("z", q0) @ _rotation("y", shoulder + elbow)).T @ desired
        q4 = math.asin(max(-1., min(1., -float(wrist_rotation[1, 2]))))
        if abs(math.cos(q4)) > 1e-8:
            q3 = math.atan2(wrist_rotation[0, 2], wrist_rotation[2, 2])
            q5 = math.atan2(wrist_rotation[1, 0], wrist_rotation[1, 1])
        else:
            q3, q5 = math.atan2(-wrist_rotation[2, 0], wrist_rotation[0, 0]), 0.
        angles = tuple(math.atan2(math.sin(x), math.cos(x)) for x in [q0, shoulder, elbow, q3, q4, q5])
        if not all(lo - 1e-9 <= angle <= hi + 1e-9 for angle, (lo, hi) in zip(angles, config.joint_limits)):
            continue
        fk = forward_kinematics(angles, config)
        residual = math.dist(position, fk["position"])
        orientation_error = float(np.linalg.norm(np.array(fk["rotation"]) - desired))
        if residual < 1e-7 and orientation_error < 1e-7:
            score = sum((a - b) ** 2 for a, b in zip(angles, current or (0.,) * 6))
            candidates.append((score, angles, residual, orientation_error))
    if not candidates:
        raise KinematicsError("JOINT_LIMIT", target_position=tuple(position))
    _, angles, residual, orientation_error = min(candidates)
    return {"joint_angles": angles, "ik_residual_m": residual, "orientation_residual": orientation_error}


def segment_intersects_box(a, b, obstacle, padding=0.):
    low, high = 0., 1.
    for axis in range(3):
        margin = padding[axis] if isinstance(padding, (tuple, list)) else padding
        lo = obstacle.center[axis] - obstacle.size[axis] / 2 - margin
        hi = obstacle.center[axis] + obstacle.size[axis] / 2 + margin
        delta = b[axis] - a[axis]
        if abs(delta) < 1e-12:
            if not lo <= a[axis] <= hi:
                return False
        else:
            start, end = sorted(((lo - a[axis]) / delta, (hi - a[axis]) / delta))
            low, high = max(low, start), min(high, end)
            if low > high:
                return False
    return True


def joint_path(start, goal, config: ArmConfig, obstacles, carried_dimensions=None):
    """Validate interpolated link capsules with a conservative displacement bound."""
    reach = config.upper_arm + config.forearm + config.tool_length
    angular_distance = sum(abs(b - a) for a, b in zip(start, goal))
    samples = max(1, math.ceil(reach * angular_distance / config.interpolation_resolution_m))
    if samples > 20000:
        raise KinematicsError("MOTION_RESOLUTION_LIMIT", required_samples=samples)
    bound = reach * angular_distance / samples
    recorded = []
    stride = max(1, math.ceil(samples / 16))
    for sample in range(samples + 1):
        alpha = sample / samples
        angles = tuple(a + (b - a) * alpha for a, b in zip(start, goal))
        if not all(lo - 1e-9 <= q <= hi + 1e-9 for q, (lo, hi) in zip(angles, config.joint_limits)):
            raise KinematicsError("JOINT_LIMIT", sample_index=sample)
        fk = forward_kinematics(angles, config)
        links = fk["link_positions"]
        for index, (a, b) in enumerate(zip(links, links[1:])):
            for obstacle in obstacles:
                if segment_intersects_box(a, b, obstacle, config.collision_radius + bound):
                    raise KinematicsError("ARM_COLLISION", obstacle_id=obstacle.id, link_index=index,
                        sample_index=sample, samples_checked=sample + 1, joint_angles=angles,
                        link_positions=links, conservative_margin_m=config.collision_radius + bound)
        if carried_dimensions:
            padding = tuple(d / 2 + bound for d in carried_dimensions)
            for obstacle in obstacles:
                if segment_intersects_box(fk["position"], fk["position"], obstacle, padding):
                    raise KinematicsError("ARM_COLLISION", obstacle_id=obstacle.id,
                        reason_detail="CARRIED_OBJECT_SWEEP", sample_index=sample,
                        samples_checked=sample + 1, joint_angles=angles)
        if sample % stride == 0 or sample == samples:
            recorded.append({"fraction": alpha, "joint_angles": angles, "position": fk["position"], "link_positions": links})
    return {"samples_checked": samples + 1, "interpolation_resolution_m": config.interpolation_resolution_m,
            "conservative_margin_m": config.collision_radius + bound, "joint_path_samples": recorded}
