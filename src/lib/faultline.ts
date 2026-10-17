/** Wire types mirror backend/models.py. This client never uses synthetic preview contracts. */
export type Vec3 = [number, number, number];
export type CoordinateFrame = "workcell_normalized" | "workcell_m";
export type ObjectEstimate = {
  id: string; label: string; position: Vec3; dimensions: Vec3; yaw_rad: number;
  visible: boolean; confidence: number; source: string; measured_fields: string[];
  assumed_fields: string[]; bbox: [number, number, number, number] | null;
};
export type ObservedScene = {
  schema_version: string; session_id: string; seq: number; timestamp_ms: number;
  coordinate_frame: CoordinateFrame; sensor_mode: string; camera_source: string;
  frame_ref: string | null; objects: ObjectEstimate[]; workspace: [number, number]; depth_available: boolean;
};
export type RobotMeshPose = { name: string; mesh: string; position: Vec3; quaternion: [number, number, number, number] };
export type Zone = { id: string; center: Vec3; size: Vec3 };
export type SimWorld = {
  episode_id: string; version: number; coordinate_frame: CoordinateFrame; workspace: [number, number];
  objects: (ObjectEstimate & { authority: "camera" | "simulator"; orientation_quaternion?: [number, number, number, number] | null })[];
  robot: { position: Vec3; gripper_state: string; holding_id: string | null;
    kinematics_kind?: "cartesian" | "six_dof_kinematic" | "robosim_physics"; joint_angles?: number[] | null;
    joint_limits?: [number, number][] | null; link_positions?: Vec3[] | null; tool_rotation?: number[][] | null; visual_model_id?: string | null; mesh_poses?: RobotMeshPose[] | null;
    native_contacts?: { body_a: string; body_b: string; distance_m?: number | null; normal_force_n?: number | null }[];
    native_physics?: { engine?: string; device?: string; sim_time?: number; contact_count?: number; jaw_closed_fraction?: number; active_arm?: string; idle_arm?: string };
  };
  destination: Zone; obstacles: Zone[]; step: number; sim_elapsed_ms: number; state: string;
};
export type TraceEvent = {
  kind: string; seq?: number; timestamp_ms?: number; sim_elapsed_ms?: number;
  episode_id?: string; data: Record<string, unknown>;
};
export type Disturbance = {
  type: string; after_action_index: number; object_id: string | null; position: Vec3 | null;
  source: "camera_observed" | "operator_injected" | "procedural"; confidence: number; frame_ref: string | null;
};
export type Scenario = {
  case_id: string; name: string; source: string; family: string; seed: number;
  task: { target_id: string; destination_id: string; instruction: string };
  initial_scene: ObservedScene; destination: Zone; obstacles: Zone[];
  disturbances: Disturbance[]; limits?: { max_actions: number; max_sim_seconds: number }; provenance: Record<string, unknown>;
};
export type PolicyManifest = {
  policy_id: string; model: string | null; version: string; prompt_hash: string | null;
  adapter_type?: string; parameters?: Record<string, unknown>;
};
export type ControllerState = { manifest: PolicyManifest; model_calls: number; inference_elapsed_ms: number };
export type CaseResult = {
  episode_id: string; case_id: string; scenario_hash: string; source: string;
  policy: PolicyManifest;
  outcome: string; reason: string; task_success: boolean; constraint_violations: string[];
  actions: number; recovery_attempts: number; sim_elapsed_ms: number; wall_elapsed_ms: number;
  inference_elapsed_ms: number; model_calls: number; trace_ref: string; verified: boolean;
};
export type SessionCredentials = { session_id: string; token: string; expires_at_ms: number };
export type SessionState = {
  session_id: string; status: string; error: string | null; camera_status: string;
  last_frame_age_ms: number | null; calibrated: boolean; observed: ObservedScene;
  world: SimWorld | null; result: CaseResult | null; events: TraceEvent[]; running: boolean;
  live_disturbances?: Disturbance[]; case_id?: string; task?: Scenario["task"]; controller?: ControllerState | null;
};
export type PolicyOption = { id: string; available: boolean; kind: string };
export type RobotDescriptor = {
  id: string; name: string; kind: string; dof: number; requires_metric?: boolean; coordinate_frames?: CoordinateFrame[];
  motion_validation?: string; scope?: string; implemented?: boolean;
};
export type EnvironmentDescriptor = { id: "camera" | "warehouse" | "physics"; name: string; purpose: string; engine: string; fidelity: string; workspace: string; units: string; robot: string; case_families: string[]; execution_backends: string[]; available: boolean };
export type ExecutionBackend = { id: "local" | "modal_cpu"; name: string; available: boolean; verified: boolean; reason?: string | null; max_concurrency: number; supported_policies: string[]; supported_environments: string[] };
export type ExecutionJob = { case_id: string; role: string; policy_id: string; scenario_hash: string; backend: string; status: "QUEUED" | "RUNNING" | "DONE" | "ERROR"; episode_id?: string; outcome?: string; started_at_ms?: number; finished_at_ms?: number; error_type?: string };
export type Health = { ok: boolean; policies: PolicyOption[]; data_mode: string; execution: string;
  robosim?: { available: boolean; verified: boolean; reason?: string | null; engine?: string | null; status?: string };
  environments?: EnvironmentDescriptor[]; execution_backends?: ExecutionBackend[];
  robots?: RobotDescriptor[]; jev?: { available: boolean; verified: boolean; model: string | null };
};
export type Gate = {
  verdict: string; reasons: string[]; paired_cases: number; eligible_cases: number; candidate_passes: number;
  candidate_completion_rate: number | null; fixes: string[]; regressions: string[]; violations: string[];
  scope: string; config: { minimum_cases: number; completion_threshold: number };
};
export type Benchmark = {
  id: string; status: string; baseline_policy: string; candidate_policy: string; total_executions: number;
  execution_backend?: "local" | "modal_cpu"; concurrency?: number; active_executions?: number; peak_concurrency?: number; actual_worker_overlap?: number | null; jobs?: ExecutionJob[]; executions?: Record<string, unknown>[];
  completed_executions: number; results: CaseResult[]; errors: unknown[]; gate: Gate | null;
  cases: { case_id: string; source: string; scenario_hash: string }[];
};
export type Episode = { result: CaseResult; scenario: Scenario; events: TraceEvent[] };

export const POLICY_NAMES: Record<string, string> = {
  scripted_open_loop: "Scripted · open loop",
  scripted_reobserve: "Scripted · reobserve",
  scripted_obstacle_aware: "Scripted · obstacle aware",
  "jev_gpt-6.1-sol": "GPT 6.1 Sol + Jev feedback",
  "jev_gpt-6-astra": "GPT 6 Astra + Jev feedback",
  "jev_claude-opus-5-5": "Claude Opus 5.5 + Jev feedback",
  "gpt-6.1-sol": "GPT 6.1 Sol",
  "gpt-6-astra": "GPT 6 Astra",
  "claude-opus-5-5": "Claude Opus 5.5",
};
export const SOURCE_NAMES: Record<string, string> = {
  captured_live_rgb: "Live RGB capture", operator_defined: "Operator injection", procedural: "Procedural simulation",
};
export function errorMessage(err: unknown) { return err instanceof Error ? err.message : String(err); }
export async function faultline<T>(path: string, options: {
  method?: "GET" | "POST"; body?: unknown; binary?: Blob; session?: SessionCredentials | null; signal?: AbortSignal;
} = {}): Promise<T> {
  const headers = new Headers();
  if (options.session) headers.set("Authorization", `Bearer ${options.session.token}`);
  if (options.binary) headers.set("Content-Type", "image/jpeg");
  else if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const res = await fetch(`/api/faultline/${path}`, {
    method: options.method ?? (options.body !== undefined || options.binary ? "POST" : "GET"),
    headers, body: options.binary ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: options.signal, cache: "no-store",
  });
  const payload = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const detail = payload.error ?? payload.detail ?? `HTTP ${res.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload as T;
}
