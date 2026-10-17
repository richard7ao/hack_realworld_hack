"""Implemented robot profiles, independent of interchangeable policy adapters.

Profiles describe simulator geometry and capabilities, not branded hardware.
Selecting a profile creates a NEW manifest; saved manifests keep their config.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

from .kinematics import ArmConfig, inverse_kinematics


class RobotAdapter(Protocol):
    profile_id: str

    def config_for(self, workspace, coordinate_frame) -> dict | None: ...
    def description(self) -> dict: ...


@dataclass(frozen=True)
class RobotProfile:
    profile_id: str
    name: str
    kind: str
    compact: bool = False

    def config_for(self, workspace, coordinate_frame):
        if len(workspace) != 2 or any(not math.isfinite(x) or x <= 0 for x in workspace):
            raise ValueError("Robot profile requires positive finite workspace dimensions")
        if coordinate_frame not in ("workcell_m", "workcell_normalized"):
            raise ValueError("Unsupported robot coordinate frame")
        if self.kind == "cartesian":
            return None
        if coordinate_frame != "workcell_m":
            raise ValueError("Six-joint robot profiles require a measured metric workspace; set calibration width and depth first")
        width, depth = workspace
        span = max(width, depth)
        # A declared generic geometry, scaled in metres from the workcell span.
        # These are explicit engineering assumptions, never camera measurements.
        config = ArmConfig(
            base_position=(width / 2, depth / 2, span * (.14 if self.compact else .1625)),
            upper_arm=span * (.20 if self.compact else .3125),
            forearm=span * (.19 if self.compact else .3125),
            tool_length=span * (.025 if self.compact else .03),
            collision_radius=span * (.005 if self.compact else .00625),
            interpolation_resolution_m=span * .005,
            safe_travel_height=span * (.275 if self.compact else .3375),
            max_height=span * (.45 if self.compact else .6),
            home_position=(width / 2 + span * .175, depth / 2, span * (.225 if self.compact else .275)),
        )
        inverse_kinematics(config.home_position, config)  # Refuse a broken profile.
        return config.as_dict()

    def description(self):
        cartesian = self.kind == "cartesian"
        return {
            "id": self.profile_id,
            "name": self.name,
            "kind": self.kind,
            "implemented": True,
            "dof": 3 if cartesian else 6,
            "joint_type": "virtual_cartesian_translation" if cartesian else "revolute",
            "coordinate_frames": ["workcell_m", "workcell_normalized"] if cartesian else ["workcell_m"],
            "action_spaces": ["symbolic_v1"],
            "policy_independent": True,
            "geometry_source": "explicit generic simulator configuration; not measured or branded hardware",
            "motion_validation": "Cartesian swept box" if cartesian else "analytic IK, joint limits, interpolated rigid-link capsules against declared AABBs",
            "joint_schema": [] if cartesian else [
                {"index": index, "name": name, "axis": axis, "unit": "rad", "limits": [-math.pi, math.pi]}
                for index, (name, axis) in enumerate([
                    ("base_yaw", "z"), ("shoulder_pitch", "y"), ("elbow_pitch", "y"),
                    ("wrist_pitch", "y"), ("wrist_roll", "x"), ("tool_yaw", "z")])],
            "scope": "kinematics only; no contact dynamics, self-collision, torque limits, hardware driver or hardware certification",
        }


ROBOT_PROFILES: dict[str, RobotAdapter] = {
    "cartesian": RobotProfile("cartesian", "Cartesian demonstration gripper", "cartesian"),
    "industrial_6r": RobotProfile("industrial_6r", "Generic industrial 6R arm", "six_dof_kinematic"),
    "compact_6r": RobotProfile("compact_6r", "Generic compact 6R arm", "six_dof_kinematic", compact=True),
}


def robot_catalog():
    return [adapter.description() for adapter in ROBOT_PROFILES.values()]


def robot_config_for(profile_id, workspace, coordinate_frame):
    if profile_id not in ROBOT_PROFILES:
        raise ValueError(f"Unknown robot profile: {profile_id}")
    return ROBOT_PROFILES[profile_id].config_for(workspace, coordinate_frame)
