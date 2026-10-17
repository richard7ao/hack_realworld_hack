"""Canonical wire models. Coordinates always use the declared scene frame."""
from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

Vec3 = tuple[float, float, float]
Frame = Literal["workcell_normalized", "workcell_m"]
Outcome = Literal["PASS", "FAIL", "UNKNOWN", "TIMEOUT", "ESCALATED"]
ActionType = Literal["OBSERVE", "MOVE_TO", "GRASP", "PLACE", "WAIT", "REQUEST_HELP", "DONE"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ObjectEstimate(Model):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    label: str = Field(default="parcel", max_length=80)
    position: Vec3
    dimensions: Vec3 = (0.1, 0.07, 0.04)
    yaw_rad: float = 0
    visible: bool = True
    confidence: float = Field(default=1, ge=0, le=1)
    source: str = "rgb_tracker"
    measured_fields: list[str] = Field(default_factory=lambda: ["x", "y"])
    assumed_fields: list[str] = Field(default_factory=lambda: ["z", "dimensions"])
    bbox: tuple[float, float, float, float] | None = None

    @model_validator(mode="after")
    def valid_dimensions(self):
        if min(self.dimensions) <= 0:
            raise ValueError("Object dimensions must be positive")
        return self


class ObservedScene(Model):
    schema_version: Literal["1.0"] = "1.0"
    kind: Literal["observed.scene"] = "observed.scene"
    session_id: str
    seq: int = Field(ge=0)
    timestamp_ms: float
    coordinate_frame: Frame = "workcell_normalized"
    sensor_mode: Literal["RGB", "RGBD", "PROCEDURAL"] = "RGB"
    camera_source: str = "laptop_web_rgb"
    frame_ref: str | None = None
    objects: list[ObjectEstimate] = Field(default_factory=list, max_length=32)
    workspace: tuple[float, float] = (1, 1)
    depth_available: bool = False

    @model_validator(mode="after")
    def unique_ids(self):
        if len({o.id for o in self.objects}) != len(self.objects):
            raise ValueError("Object identities must be unique")
        if min(self.workspace) <= 0:
            raise ValueError("Workspace dimensions must be positive")
        return self


class Zone(Model):
    id: str = "outbound_bin"
    center: Vec3 = (0.82, 0.78, 0.04)
    size: Vec3 = (0.3, 0.3, 0.2)

    @model_validator(mode="after")
    def positive_size(self):
        if min(self.size) <= 0:
            raise ValueError("Zone size must be positive")
        return self


class Robot(Model):
    position: Vec3 = (0.1, 0.1, 0.25)
    gripper_state: Literal["open", "closed"] = "open"
    holding_id: str | None = None
    kinematics_kind: Literal["cartesian", "six_dof_kinematic"] = "cartesian"
    joint_angles: list[float] | None = None
    joint_limits: list[tuple[float, float]] | None = None
    link_positions: list[Vec3] | None = None
    tool_rotation: list[list[float]] | None = None


class SimObject(ObjectEstimate):
    authority: Literal["camera", "simulator"] = "camera"


class SimWorld(Model):
    schema_version: Literal["1.0"] = "1.0"
    episode_id: str
    version: int = 0
    coordinate_frame: Frame
    workspace: tuple[float, float]
    objects: list[SimObject]
    robot: Robot = Field(default_factory=Robot)
    destination: Zone = Field(default_factory=Zone)
    obstacles: list[Zone] = Field(default_factory=list)
    step: int = 0
    sim_elapsed_ms: float = 0
    state: Literal["IDLE", "RUNNING", "DISTURBED", "RECOVERING", "PASSED", "FAILED", "ESCALATED", "TIMEOUT"] = "IDLE"


class Task(Model):
    target_id: str
    destination_id: str = "outbound_bin"
    instruction: str = "Pick the target and place it in the outbound bin"


class PolicyAction(Model):
    type: ActionType
    target_id: str | None = None
    position: Vec3 | None = None
    orientation_rpy: Vec3 | None = None
    reason: str = Field(default="", max_length=500)
    max_execution_ms: int = Field(default=3000, ge=1, le=10000)


class ActionResult(Model):
    status: Literal["ok", "rejected"] = "ok"
    reason: str = "OK"
    action_type: ActionType | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class PolicyObservation(Model):
    schema_version: Literal["1.0"] = "1.0"
    episode_id: str
    step: int
    timestamp_ms: float
    observed_at_step: int
    coordinate_frame: Frame
    task: Task
    robot: Robot
    detected_objects: list[ObjectEstimate]
    destination: Zone
    observed_obstacles: list[Zone]
    last_action_result: ActionResult
    workspace: tuple[float, float]
    camera_frame_ref: str | None = None


class PolicyManifest(Model):
    policy_id: str
    version: str
    adapter_type: Literal["scripted", "symbolic_tool_agent"]
    model: str | None = None
    prompt_hash: str | None = None
    observation_modalities: list[str] = ["object_estimates", "robot_feedback", "last_action_result"]
    action_space: Literal["symbolic_v1"] = "symbolic_v1"
    coordinate_frames: list[Frame] = ["workcell_normalized", "workcell_m"]
    max_rate_hz: float = 5
    deterministic: bool = True
    parameters: dict[str, Any] = Field(default_factory=dict)


class Disturbance(Model):
    type: Literal["MOVE_OBJECT", "OCCLUDE_OBJECT", "ADD_OBSTACLE", "MOVE_DESTINATION"]
    after_action_index: int = Field(ge=0)
    object_id: str | None = None
    position: Vec3 | None = None
    obstacle: Zone | None = None
    source: Literal["camera_observed", "operator_injected", "procedural"] = "procedural"
    confidence: float = Field(default=1, ge=0, le=1)
    frame_ref: str | None = None

    @model_validator(mode="after")
    def required_parameters(self):
        if self.type in ("MOVE_OBJECT", "OCCLUDE_OBJECT") and not self.object_id:
            raise ValueError("Object disturbance requires object_id")
        if self.type in ("MOVE_OBJECT", "MOVE_DESTINATION") and self.position is None:
            raise ValueError("Movement disturbance requires position")
        if self.type == "ADD_OBSTACLE" and self.obstacle is None:
            raise ValueError("Obstacle disturbance requires geometry")
        return self


class Limits(Model):
    max_actions: int = Field(default=24, ge=1, le=100)
    max_sim_seconds: float = Field(default=45, gt=0, le=300)


class Scenario(Model):
    schema_version: Literal["1.0"] = "1.0"
    case_id: str = Field(pattern=r"^[a-zA-Z0-9_-]+$")
    name: str
    source: Literal["captured_live_rgb", "procedural", "operator_defined"]
    family: str = "target_displacement"
    seed: int
    task: Task
    initial_scene: ObservedScene
    destination: Zone = Field(default_factory=Zone)
    obstacles: list[Zone] = Field(default_factory=list)
    disturbances: list[Disturbance] = Field(default_factory=list)
    limits: Limits = Field(default_factory=Limits)
    success_predicate: Literal["correct_item_in_outbound_and_no_forbidden_collision"] = "correct_item_in_outbound_and_no_forbidden_collision"
    evaluator_version: Literal["oracle_v1"] = "oracle_v1"
    provenance: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid_task(self):
        if self.task.target_id not in {o.id for o in self.initial_scene.objects}:
            raise ValueError("Task target must exist in the initial scene")
        if self.task.destination_id != self.destination.id:
            raise ValueError("Task destination must match scenario destination")
        identities = {o.id for o in self.initial_scene.objects}
        if any(d.object_id is not None and d.object_id not in identities for d in self.disturbances):
            raise ValueError("Disturbance object must exist in initial scene")
        return self


class Event(Model):
    schema_version: Literal["1.0"] = "1.0"
    kind: str
    seq: int
    timestamp_ms: float
    sim_elapsed_ms: float = 0
    session_id: str | None = None
    episode_id: str | None = None
    data: dict[str, Any]


class CaseResult(Model):
    episode_id: str
    case_id: str
    scenario_hash: str
    source: str
    policy: PolicyManifest
    outcome: Outcome
    reason: str
    task_success: bool
    constraint_violations: list[str]
    actions: int
    recovery_attempts: int
    sim_elapsed_ms: float
    wall_elapsed_ms: float
    inference_elapsed_ms: float
    model_calls: int
    trace_ref: str
    evaluator_version: Literal["oracle_v1"] = "oracle_v1"
    verified: bool = True


class GateConfig(Model):
    minimum_cases: int = Field(default=3, ge=1)
    completion_threshold: float = Field(default=0.8, ge=0, le=1)


class Calibration(Model):
    corners: list[tuple[float, float]] = Field(min_length=4, max_length=4)
    width: float | None = Field(default=None, gt=0, le=5)
    depth: float | None = Field(default=None, gt=0, le=5)

    @model_validator(mode="after")
    def both_dimensions(self):
        if (self.width is None) != (self.depth is None):
            raise ValueError("Enter both measured width and depth, or leave both normalized")
        return self
