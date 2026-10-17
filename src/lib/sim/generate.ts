import type { ActionType, Benchmark, BenchmarkCase, CaseDetail, CaseResult, Family, Outcome, PolicyManifest, Reason, Scenario, SceneObject, TraceStep, Vec3 } from "../contract";
import { FAMILIES } from "../contract";
import { between, hashSeed, intBetween, mulberry32 } from "../rng";

/**
 * Deterministic DEMO data for FAULTLINE Pick, served until the real backend is live.
 *
 * Nothing here was executed. Every run is labelled source "demo_fixture" and the UI says so.
 * The data is still held to the rules a real run must obey, so the screens are exercised honestly:
 *  - A case's scenario depends only on its case id, never on the policy, so runs are comparable.
 *  - The outcome is scripted per policy, family and the case's difficulty rank within its family.
 *  - The trace is built from that script, and the result is derived from the trace, so the two can
 *    never disagree (actions, recovery attempts, simulated time).
 */

export const SUITE = "PickLab-100";
export const EVALUATOR_VERSION = "oracle_v1";
export const CONCURRENCY = 10;
export const DEFAULT_CREATED_AT = "2026-10-17T12:00:00.000Z";
export const CASES_PER_FAMILY = 20;

export const BASELINE_ID = "pick_policy_v1.4";
export const RC1_ID = "pick_policy_v1.5-rc1";
export const RC2_ID = "pick_policy_v1.5-rc2";

const manifest = (policy_id: string): PolicyManifest => ({
  policy_id,
  adapter_type: "scripted",
  model: null,
  prompt_version: null,
  observation_modalities: ["object_estimates", "last_action_result"],
  action_space: "symbolic_v1",
  max_actions: 12,
});

/** Fictional scripted policies. v1.4 is open loop; both candidates add re-observation. */
export const POLICIES: PolicyManifest[] = [manifest(BASELINE_ID), manifest(RC1_ID), manifest(RC2_ID)];

/**
 * Simulated execution time per action, in ms. Rule used everywhere: a step starts at the previous
 * step's start plus that step's duration, and sim_elapsed_ms is the last step's start plus its own
 * duration. Headless scripted execution is compressed, so wall time always exceeds sim time.
 */
export const STEP_MS: Record<ActionType, number> = { OBSERVE: 120, MOVE_TO: 380, GRASP: 260, PLACE: 300, WAIT: 600, REQUEST_HELP: 80, DONE: 40 };

export const CASE_IDS: string[] = Array.from({ length: FAMILIES.length * CASES_PER_FAMILY }, (_, i) => `PICK-${String(i + 1).padStart(3, "0")}`);

// ---------------------------------------------------------------------------------------------
// Scenario, a function of the case id alone
// ---------------------------------------------------------------------------------------------

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const v = (x: number, y: number, z: number): Vec3 => [r3(x), r3(y), r3(z)];
const add = (a: Vec3, b: Vec3): Vec3 => v(a[0] + b[0], a[1] + b[1], a[2] + b[2]);

function caseIndex(case_id: string): number {
  const m = /^PICK-(\d{3})$/.exec(case_id);
  const i = m ? Number(m[1]) : NaN;
  if (!(i >= 1 && i <= CASE_IDS.length)) throw new Error(`unknown case_id "${case_id}"`);
  return i;
}

export const familyOf = (case_id: string): Family => FAMILIES[Math.floor((caseIndex(case_id) - 1) / CASES_PER_FAMILY)]!;
export const seedOf = (case_id: string): number => 40000 + (hashSeed(case_id) % 10000);

/** Difficulty rank 0 (easiest) to 19 within the family: a seeded permutation, fixed per family. */
export function rankOf(case_id: string): number {
  const family = familyOf(case_id);
  const rnd = mulberry32(hashSeed(`rank:${family}`));
  const keys = Array.from({ length: CASES_PER_FAMILY }, () => rnd());
  const pos = (caseIndex(case_id) - 1) % CASES_PER_FAMILY;
  return keys.filter((k) => k < keys[pos]!).length;
}

const TARGET = "parcel_A";
const DECOY = "parcel_A2";
const OBSTACLE = "obstacle_D";
const DESTINATION = "outbound_bin";
const DEST_POS: Vec3 = [0.82, 0.5, 0];

/** Displacement magnitude grows with rank. Below rank 10 it is inside the gripper's tolerance. */
const moveMagnitude = (rank: number) => (rank < 18 ? 0.03 + rank * 0.006 : 0.2 + (rank - 18) * 0.04);
/** Destination shift. Below rank 17 the planned place pose still lands inside the moved bin. */
const destMagnitude = (rank: number) => (rank < 17 ? 0.02 + rank * 0.005 : 0.18 + (rank - 17) * 0.04);

export function scenarioFor(case_id: string): Scenario {
  const family = familyOf(case_id);
  const seed = seedOf(case_id);
  const rank = rankOf(case_id);
  const rnd = mulberry32(seed);
  const target = v(between(rnd, 0.25, 0.45), between(rnd, 0.35, 0.65), 0.04);
  const angle = between(rnd, 0, Math.PI * 2);
  const trigger = rnd() < 0.5 ? 1 : 2;
  const withSlender = rnd() < 0.5;
  const sign = rnd() < 0.5 ? -1 : 1;
  const yaw = r3(between(rnd, -0.6, 0.6));
  const decoyOffset = v(between(rnd, 0.07, 0.1), between(rnd, -0.05, 0.05), 0);

  const obj = (id: string, cls: SceneObject["class"], role: SceneObject["role"], position_m: Vec3, dimensions_m: Vec3, yaw_rad = 0): SceneObject => ({ id, class: cls, role, position_m, yaw_rad, dimensions_m });
  const objects: SceneObject[] = [
    obj(TARGET, "parcel", "target", target, [0.12, 0.09, 0.08], yaw),
    obj("carton_B", "carton", "distractor", v(0.18, 0.82, 0.05), [0.14, 0.12, 0.1]),
    ...(withSlender ? [obj("slender_C", "slender", "distractor", v(0.55, 0.18, 0.06), [0.03, 0.03, 0.12])] : []),
    // Listed at the pose the scheduled disturbance inserts them, so the inspector can draw them.
    ...(family === "clutter_ambiguity" ? [obj(DECOY, "parcel", "distractor", add(target, decoyOffset), [0.12, 0.09, 0.08], yaw)] : []),
    ...(family === "workspace_obstruction" ? [obj(OBSTACLE, "obstacle", "obstacle", v((target[0] + DEST_POS[0]) / 2, (target[1] + DEST_POS[1]) / 2, 0.075), [0.06, 0.22, 0.15])] : []),
  ];

  const effect = {
    target_displacement: { type: "MOVE_OBJECT" as const, object_id: TARGET, delta_m: v(moveMagnitude(rank) * Math.cos(angle), moveMagnitude(rank) * Math.sin(angle), 0) },
    visual_occlusion: { type: "OCCLUDE" as const, object_id: TARGET, delta_m: null },
    workspace_obstruction: { type: "INSERT_OBSTACLE" as const, object_id: OBSTACLE, delta_m: null },
    clutter_ambiguity: { type: "ADD_SIMILAR" as const, object_id: DECOY, delta_m: null },
    destination_change: { type: "MOVE_DESTINATION" as const, object_id: DESTINATION, delta_m: v(0, sign * destMagnitude(rank), 0) },
  }[family];
  const disturbance: Scenario["disturbance"] = { ...effect, trigger: { after_action_index: trigger } };

  return {
    schema_version: "1.0",
    case_id,
    source: "demo_fixture",
    family,
    seed,
    task: { target_id: TARGET, destination_id: DESTINATION },
    initial_scene_ref: null,
    initial_scene: { coordinate_frame: "workcell_normalized", objects, destination: { id: DESTINATION, position_m: DEST_POS, size_m: [0.16, 0.22] } },
    disturbance,
    limits: { max_actions: 12, max_sim_seconds: 30 },
    success_predicate: "correct_item_in_outbound_and_no_forbidden_collision",
    provenance: { capture_frame_ref: null, observation_confidence: null },
  };
}
