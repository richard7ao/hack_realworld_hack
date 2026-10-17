import { z } from "zod";

/**
 * FAULTLINE Pick frontend contract, conformed to the PRD build brief (sections D and I).
 *
 * Field names are snake_case because the backend is FastAPI/Pydantic and these shapes are read
 * straight off the wire. Every response is parsed here at the boundary, so a backend drift fails
 * loudly next to the schema that describes it. Additive changes only once the backend ships.
 */

// ---------------------------------------------------------------------------------------------
// Enumerations (PRD 7, 8; build brief D4, D6, J)
// ---------------------------------------------------------------------------------------------

/** PickLab-100: five disturbance families, twenty seeds each. */
export const FAMILIES = ["target_displacement", "visual_occlusion", "workspace_obstruction", "clutter_ambiguity", "destination_change"] as const;
export const Family = z.enum(FAMILIES);
export type Family = z.infer<typeof Family>;

export const FAMILY_LABEL: Record<Family, string> = {
  target_displacement: "Target displacement",
  visual_occlusion: "Visual occlusion",
  workspace_obstruction: "Workspace obstruction",
  clutter_ambiguity: "Clutter and ambiguity",
  destination_change: "Destination change",
};

/** Kept separate on purpose: ESCALATED is never counted as success, TIMEOUT is not a FAIL. */
export const OUTCOMES = ["PASS", "FAIL", "UNKNOWN", "TIMEOUT", "ESCALATED"] as const;
export const Outcome = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof Outcome>;

/** Why the executor rejected an action. The policy never asserts its own success. */
export const REASONS = [
  "TARGET_DISPLACED", "NOT_VISIBLE", "OBSTRUCTED", "OUT_OF_REACH", "INVALID_POSE",
  "TIMEOUT", "ALREADY_HOLDING", "EMPTY_GRIPPER", "WRONG_OBJECT",
] as const;
export const Reason = z.enum(REASONS);
export type Reason = z.infer<typeof Reason>;

export const REASON_LABEL: Record<Reason, string> = {
  TARGET_DISPLACED: "Target displaced",
  NOT_VISIBLE: "Target not visible",
  OBSTRUCTED: "Path obstructed",
  OUT_OF_REACH: "Out of reach",
  INVALID_POSE: "Invalid pose",
  TIMEOUT: "Timed out",
  ALREADY_HOLDING: "Already holding",
  EMPTY_GRIPPER: "Empty gripper",
  WRONG_OBJECT: "Wrong object",
};

export const ACTIONS = ["OBSERVE", "MOVE_TO", "GRASP", "PLACE", "WAIT", "REQUEST_HELP", "DONE"] as const;
export const ActionType = z.enum(ACTIONS);
export type ActionType = z.infer<typeof ActionType>;

/**
 * Where a trial came from. The PRD forbids aggregating differently sourced trials as if they were
 * equally physical, so every run carries one of these and the UI labels it.
 */
export const SOURCES = ["procedural_scripted", "frontier_policy", "live_capture", "demo_fixture"] as const;
export const Source = z.enum(SOURCES);
export type Source = z.infer<typeof Source>;

export const SOURCE_LABEL: Record<Source, string> = {
  procedural_scripted: "Procedural, scripted policy",
  frontier_policy: "Procedural, frontier policy",
  live_capture: "Live physical capture",
  demo_fixture: "Demo data, not executed",
};

// ---------------------------------------------------------------------------------------------
// Scenario (build brief D5)
// ---------------------------------------------------------------------------------------------

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const SceneObject = z.object({
  id: z.string(),
  class: z.enum(["parcel", "carton", "slender", "bottle", "obstacle"]),
  role: z.enum(["target", "distractor", "obstacle"]),
  position_m: Vec3,
  yaw_rad: z.number(),
  dimensions_m: Vec3,
});
export type SceneObject = z.infer<typeof SceneObject>;

export const DISTURBANCES = ["NONE", "MOVE_OBJECT", "OCCLUDE", "INSERT_OBSTACLE", "ADD_SIMILAR", "MOVE_DESTINATION"] as const;

export const Disturbance = z.object({
  type: z.enum(DISTURBANCES),
  object_id: z.string().nullable(),
  /** Scheduled at an action boundary, never wall time (build brief G). */
  trigger: z.object({ after_action_index: z.number().int().nonnegative() }),
  delta_m: Vec3.nullable(),
});
export type Disturbance = z.infer<typeof Disturbance>;

export const Scenario = z.object({
  schema_version: z.string(),
  case_id: z.string(),
  source: Source,
  family: Family,
  seed: z.number().int(),
  task: z.object({ target_id: z.string(), destination_id: z.string() }),
  initial_scene_ref: z.string().nullable(),
  /** Inline copy of the initial scene. Optional on the wire; the inspector draws a placeholder without it. */
  initial_scene: z.object({
    coordinate_frame: z.enum(["workcell_m", "workcell_normalized"]),
    objects: z.array(SceneObject),
    destination: z.object({ id: z.string(), position_m: Vec3, size_m: z.tuple([z.number(), z.number()]) }),
  }).nullable(),
  disturbance: Disturbance,
  limits: z.object({ max_actions: z.number().int().positive(), max_sim_seconds: z.number().positive() }),
  success_predicate: z.string(),
  provenance: z.object({ capture_frame_ref: z.string().nullable(), observation_confidence: z.number().min(0).max(1).nullable() }),
});
export type Scenario = z.infer<typeof Scenario>;

// ---------------------------------------------------------------------------------------------
// Results and traces (build brief D4, D6)
// ---------------------------------------------------------------------------------------------

export const CaseResult = z.object({
  case_id: z.string(),
  policy_version: z.string(),
  outcome: Outcome,
  reason: Reason.nullable(),
  task_success: z.boolean(),
  /** e.g. "wrong_object_grasp_attempt", "forbidden_collision". Hard safety rules are named in GateConfig. */
  constraint_violations: z.array(z.string()),
  actions: z.number().int().nonnegative(),
  recovery_attempts: z.number().int().nonnegative(),
  sim_elapsed_ms: z.number().nonnegative(),
  wall_elapsed_ms: z.number().nonnegative(),
  trace_ref: z.string().nullable(),
  evaluator_version: z.string(),
});
export type CaseResult = z.infer<typeof CaseResult>;

/**
 * One executed step. Belief and truth are both recorded so the inspector can show a stale belief,
 * the central failure the PRD exists to expose. Truth is for the evaluator and the UI only; it
 * is never part of what the policy observed.
 */
export const TraceStep = z.object({
  seq: z.number().int().nonnegative(),
  sim_time_ms: z.number().nonnegative(),
  action: z.object({ type: ActionType, target_id: z.string().nullable(), target_position_m: Vec3.nullable() }),
  result: z.object({ status: z.enum(["ok", "rejected"]), reason: Reason.nullable() }),
  belief_target_m: Vec3.nullable(),
  true_target_m: Vec3.nullable(),
  /** Set on the step at which the scheduled disturbance was applied. */
  disturbance_applied: z.boolean(),
  note: z.string().nullable(),
});
export type TraceStep = z.infer<typeof TraceStep>;

export const PolicyManifest = z.object({
  policy_id: z.string(),
  adapter_type: z.enum(["scripted", "symbolic_tool_agent", "vla"]),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  observation_modalities: z.array(z.string()),
  action_space: z.string(),
  max_actions: z.number().int().positive(),
});
export type PolicyManifest = z.infer<typeof PolicyManifest>;

// ---------------------------------------------------------------------------------------------
// Benchmark runs (build brief I, J)
// ---------------------------------------------------------------------------------------------

export const CASE_STATUSES = ["pending", "running", "done"] as const;

export const BenchmarkCase = z.object({
  case_id: z.string(),
  family: Family,
  seed: z.number().int(),
  status: z.enum(CASE_STATUSES),
  /** Wall-clock schedule relative to run start, so the grid can animate between polls. */
  started_at_ms: z.number().nonnegative().nullable(),
  finished_at_ms: z.number().nonnegative().nullable(),
  result: CaseResult.nullable(),
});
export type BenchmarkCase = z.infer<typeof BenchmarkCase>;

export const Benchmark = z.object({
  run_id: z.string(),
  created_at: z.string(),
  suite: z.string(),
  source: Source,
  status: z.enum(["queued", "running", "done"]),
  policy: PolicyManifest,
  evaluator_version: z.string(),
  /** Bounded worker pool size, so the grid can show a queue draining. */
  concurrency: z.number().int().positive(),
  cases: z.array(BenchmarkCase),
});
export type Benchmark = z.infer<typeof Benchmark>;

export const CaseDetail = z.object({
  run_id: z.string(),
  scenario: Scenario,
  result: CaseResult.nullable(),
  trace: z.array(TraceStep),
});
export type CaseDetail = z.infer<typeof CaseDetail>;

// ---------------------------------------------------------------------------------------------
// Release gate (PRD 8, build brief J)
// ---------------------------------------------------------------------------------------------

export const GateConfig = z.object({
  min_tests: z.number().int().positive(),
  completion_threshold: z.number().min(0).max(1),
  /** constraint_violations entries that count as hard safety violations. */
  hard_safety_violations: z.array(z.string()),
  /** Reasons that make a regression critical. */
  critical_reasons: z.array(Reason),
});
export type GateConfig = z.infer<typeof GateConfig>;

export const GateRule = z.object({
  id: z.enum(["min_tests", "hard_safety", "completion", "critical_regression"]),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type GateRule = z.infer<typeof GateRule>;

const RunSummary = z.object({
  run_id: z.string(),
  policy_id: z.string(),
  source: Source,
  executed: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  outcomes: z.record(Outcome, z.number().int().nonnegative()),
});

export const GateResult = z.object({
  decision: z.enum(["PASS", "BLOCK", "INSUFFICIENT_EVIDENCE"]),
  config: GateConfig,
  baseline: RunSummary,
  candidate: RunSummary,
  rules: z.array(GateRule),
  fixed: z.array(z.string()),
  regressed: z.array(z.string()),
  critical_regressions: z.array(z.string()),
  still_failing: z.array(z.string()),
  safety_violations: z.array(z.object({ case_id: z.string(), violation: z.string() })),
  by_family: z.array(z.object({ family: Family, n: z.number().int(), baseline_passed: z.number().int(), candidate_passed: z.number().int() })),
  evaluated_at: z.string(),
});
export type GateResult = z.infer<typeof GateResult>;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const RunBenchmarkRequest = z.object({ suite: z.string().min(1), policy_id: z.string().min(1) });
export const RunBenchmarkResponse = z.object({ run_id: z.string() });
export const GateRequest = z.object({ baseline_run_id: z.string().min(1), candidate_run_id: z.string().min(1) });
export const RerunRequest = z.object({ policy_id: z.string().min(1) });
export const RerunResponse = z.object({ run_id: z.string(), case_id: z.string(), result: CaseResult, trace: z.array(TraceStep) });
/** Extension, not in the PRD endpoint table: lets the landing page list runs to open. */
export const BenchmarkList = z.object({
  benchmarks: z.array(z.object({ run_id: z.string(), policy_id: z.string(), source: Source, status: z.enum(["queued", "running", "done"]), created_at: z.string() })),
  policies: z.array(PolicyManifest),
});

// ---------------------------------------------------------------------------------------------
// Endpoint registry. Paths are relative to /api, matching build brief I.
// ---------------------------------------------------------------------------------------------

export const endpoints = {
  benchmarkList: { method: "GET", path: "/benchmarks", response: BenchmarkList, fixture: "benchmark-list" },
  runBenchmark: { method: "POST", path: "/benchmarks/run", response: RunBenchmarkResponse, request: RunBenchmarkRequest },
  benchmark: { method: "GET", path: "/benchmarks/:run_id", response: Benchmark },
  caseDetail: { method: "GET", path: "/benchmarks/:run_id/cases/:case_id", response: CaseDetail },
  scenario: { method: "GET", path: "/scenarios/:case_id", response: Scenario },
  rerun: { method: "POST", path: "/replays/:case_id/rerun", response: RerunResponse, request: RerunRequest },
  gate: { method: "POST", path: "/gates/evaluate", response: GateResult, request: GateRequest },
} as const;

export type EndpointName = keyof typeof endpoints;
export type ResponseOf<N extends EndpointName> = z.infer<(typeof endpoints)[N]["response"]>;

/** Substitute `:param` segments. Keeps path building in one place. */
export function buildPath<N extends EndpointName>(name: N, params: Record<string, string> = {}): string {
  return endpoints[name].path.replace(/:(\w+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`buildPath(${name}): missing param "${k}"`);
    return encodeURIComponent(v);
  });
}
