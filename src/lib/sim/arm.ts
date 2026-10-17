import type { Sim } from "../contract";
import { mulberry32 } from "../rng";

/**
 * A planar 2-link arm solved with closed-form inverse kinematics, animated through a scripted
 * pick-and-place. Everything is a pure function of (sim, progress), so a cell can be drawn at any
 * frame without keeping state, a run can be scrubbed, and the motion is identical on every replay.
 *
 * Coordinates are a unit square with y pointing DOWN, matching canvas. The renderer scales them.
 */
export type Pt = { x: number; y: number };

export const BASE: Pt = { x: 0.22, y: 0.78 };
export const L1 = 0.34;
export const L2 = 0.30;
export const FLOOR_Y = 0.80;
/** Object radius, in unit coords. */
export const OBJ_R = 0.045;
export const BIN = { x: 0.60, y: 0.66, w: 0.19, h: 0.14 };
/** Unit-space gravity, tuned so a slipped object falls to the floor in roughly half a second. */
const G = 3.0;

const HOME: Pt = { x: 0.40, y: 0.40 };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Static geometry for one rollout: where the object starts, and where the clutter sits. */
export type Scene = { pick: Pt; place: Pt; distractors: Pt[] };

export function scene(sim: Sim): Scene {
  const rnd = mulberry32(sim.seed ^ 0x9e3779b9);
  const pick = { x: 0.50 + sim.variant.objectDx * 0.09, y: FLOOR_Y - OBJ_R };
  const place = { x: BIN.x + BIN.w / 2, y: BIN.y + 0.02 };
  const distractors = Array.from({ length: sim.variant.distractors }, () => ({
    x: clamp(0.33 + rnd() * 0.23, 0.32, 0.56),
    y: FLOOR_Y - 0.018 - rnd() * 0.012,
  }));
  return { pick, place, distractors };
}

/**
 * The task script. `t` is cumulative progress at the END of each phase; the arm eases between the
 * waypoint it left and the one it is heading for.
 */
type Phase = { t: number; at: (s: Scene) => Pt; grip: number; hold: boolean };
const SCRIPT: Phase[] = [
  { t: 0.00, at: () => HOME, grip: 1, hold: false },
  { t: 0.14, at: (s) => ({ x: s.pick.x, y: 0.46 }), grip: 1, hold: false },
  { t: 0.28, at: (s) => s.pick, grip: 1, hold: false },
  { t: 0.38, at: (s) => s.pick, grip: 0, hold: true },
  { t: 0.50, at: (s) => ({ x: s.pick.x, y: 0.44 }), grip: 0, hold: true },
  { t: 0.70, at: (s) => ({ x: s.place.x, y: 0.46 }), grip: 0, hold: true },
  { t: 0.84, at: (s) => s.place, grip: 0, hold: true },
  { t: 0.90, at: (s) => s.place, grip: 1, hold: false },
  { t: 1.00, at: () => HOME, grip: 1, hold: false },
];

/** Where the gripper is aiming at progress p, plus whether it should be carrying the object. */
function target(s: Scene, p: number): { at: Pt; grip: number; hold: boolean } {
  const i = Math.max(0, SCRIPT.findIndex((ph) => ph.t >= p) - 1);
  const from = SCRIPT[i] ?? SCRIPT[0]!;
  const to = SCRIPT[Math.min(i + 1, SCRIPT.length - 1)] ?? from;
  const span = to.t - from.t;
  const k = span > 0 ? easeInOut(clamp((p - from.t) / span, 0, 1)) : 1;
  const a = from.at(s);
  const b = to.at(s);
  return { at: { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) }, grip: lerp(from.grip, to.grip, k), hold: to.hold && from.hold ? true : k > 0.5 ? to.hold : from.hold };
}

/**
 * Two-link IK. Reaches for `goal`; if it is beyond reach the arm extends as far as it can toward it,
 * which is what a real controller's saturated solution looks like.
 */
export function solve(goal: Pt, elbow: 1 | -1): { joint: Pt; tip: Pt; angle: number } {
  const dx = goal.x - BASE.x;
  const dy = goal.y - BASE.y;
  const d = clamp(Math.hypot(dx, dy), Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);
  const toGoal = Math.atan2(dy, dx);
  const inner = clamp((d * d + L1 * L1 - L2 * L2) / (2 * L1 * d), -1, 1);
  const a1 = toGoal - elbow * Math.acos(inner);
  const elbowAngle = clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1);
  const a2 = a1 + elbow * (Math.PI - Math.acos(elbowAngle));
  const joint = { x: BASE.x + L1 * Math.cos(a1), y: BASE.y + L1 * Math.sin(a1) };
  const tip = { x: joint.x + L2 * Math.cos(a2), y: joint.y + L2 * Math.sin(a2) };
  return { joint, tip, angle: a2 };
}

export type Pose = {
  joint: Pt;
  tip: Pt;
  angle: number;
  grip: number;
  holding: boolean;
  object: Pt;
  /** The object came to rest inside the bin: the only visual that means "success". */
  landedInBin: boolean;
  /** 0 unless the arm has struck something; drives the shake and the impact marker. */
  impact: number;
};

/**
 * Remaps progress for a timing failure. A timed-out episode does not stop, it crawls: the policy
 * keeps issuing actions that barely move the arm until the harness kills it.
 */
function effective(sim: Sim, p: number): number {
  if (sim.failMode !== "timeout" || sim.failAt === null || p <= sim.failAt) return p;
  return sim.failAt + (1 - Math.exp(-2.5 * (p - sim.failAt))) * 0.3;
}

/** Full arm + object state at progress p (0..1). Pure: same inputs, same pose, every time. */
export function poseAt(sim: Sim, s: Scene, p: number): Pose {
  const failAt = sim.failAt;
  const mode = sim.failMode;
  const collided = mode === "collision" && failAt !== null && p >= failAt;
  // A collision stops the arm dead at the point of contact and shakes it.
  const pEff = collided ? failAt! : effective(sim, clamp(p, 0, 1));
  const aim = target(s, pEff);

  // A missed approach reaches for where the policy *thinks* the object is, which is not where it is.
  const bias = mode === "missed_approach" ? sim.variant.objectDx * 0.055 + 0.045 : 0;
  const goal = { x: aim.at.x + bias, y: aim.at.y };
  const { joint, tip, angle } = solve(goal, sim.elbow);

  const slipped = (mode === "grasp_slip" || mode === "dropped_outside") && failAt !== null && p >= failAt;
  const neverGrasped = mode === "missed_approach" || mode === "timeout";
  const holding = aim.hold && !slipped && !neverGrasped && !collided;

  let object: Pt;
  let landedInBin = false;
  if (holding) {
    object = { x: tip.x, y: tip.y + OBJ_R * 0.7 };
  } else if (slipped) {
    // Free fall from wherever the gripper let go, then it rests on the floor.
    const dropped = poseAt({ ...sim, failMode: null, failAt: null }, s, failAt!);
    const t = ((p - failAt!) * sim.durationMs) / 1000;
    const y = Math.min(FLOOR_Y - OBJ_R, dropped.object.y + 0.5 * G * t * t);
    object = { x: dropped.object.x, y };
  } else if (pEff >= 0.9 && !neverGrasped && !collided) {
    object = s.place;
    landedInBin = true;
  } else {
    object = s.pick;
  }

  // Shake decays over the half second after contact.
  const impact = collided ? Math.max(0, 1 - ((p - failAt!) * sim.durationMs) / 500) : 0;
  return { joint, tip, angle, grip: aim.grip, holding, object, landedInBin, impact };
}

/** Progress of one sim at `elapsedMs` since the run started. Clamped to [0, 1]. */
export function progressAt(sim: Sim, elapsedMs: number): number {
  return clamp((elapsedMs - sim.startOffsetMs) / sim.durationMs, 0, 1);
}

/** What a cell should show at `elapsedMs`, independent of the status the backend last reported. */
export function phaseAt(sim: Sim, elapsedMs: number): "queued" | "booting" | "running" | "settled" {
  if (elapsedMs < sim.startOffsetMs) return elapsedMs < sim.startOffsetMs - 450 ? "queued" : "booting";
  return elapsedMs >= sim.startOffsetMs + sim.durationMs ? "settled" : "running";
}
