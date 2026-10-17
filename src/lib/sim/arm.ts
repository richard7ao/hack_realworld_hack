import type { BenchmarkCase, Family, Outcome, Reason } from "../contract";
import { mulberry32 } from "../rng";

/**
 * A planar 2-link arm solved with closed-form inverse kinematics, animated through a scripted
 * pick-and-place for one PickLab case. Everything is a pure function of (script, scene, progress),
 * so a tile can be drawn at any frame without keeping state, a run can be scrubbed, and the motion
 * is identical on every replay.
 *
 * This is a planning-level picture: the executor rejects an action and the arm stops at the point
 * where it was rejected. There is no grip force, friction or falling here, on purpose (PRD 7).
 *
 * Coordinates are a unit square with y pointing DOWN, matching canvas. The renderer scales them.
 */
export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const BASE: Pt = { x: 0.16, y: 0.78 };
export const L1 = 0.36;
export const L2 = 0.32;
export const FLOOR_Y = 0.80;
/** Parcel size, in unit coords. */
export const OBJ_W = 0.06;
export const OBJ_H = 0.05;
/** Where a parcel's centre sits when it rests on the floor or the bin floor. */
export const REST_Y = FLOOR_Y - OBJ_H / 2;
/** The outbound bin before any destination change. Open-topped, standing on the floor. */
export const BIN: Rect = { x: 0.54, y: 0.68, w: 0.12, h: 0.12 };
/** How far a destination change moves the bin. Far enough that its old centre is clearly outside. */
const BIN_SHIFT = 0.14;
export const HOME: Pt = { x: 0.36, y: 0.40 };
/** A case with no finish time animates over this long. */
export const DEFAULT_DURATION_MS = 2800;

const HOVER_Y = 0.50;
const HIGH_Y = 0.34;
/** The tip sits this far above a parcel's centre when holding it. */
const GRASP_DY = 0.03;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

export type CellScript = {
  case_id: string;
  seed: number;
  family: Family;
  /** null while running: render the nominal motion. */
  outcome: Outcome | null;
  reason: Reason | null;
  startOffsetMs: number;
  durationMs: number;
  elbow: 1 | -1;
};

export function cellScript(c: BenchmarkCase): CellScript {
  const start = c.started_at_ms ?? 0;
  const finish = c.finished_at_ms;
  const durationMs = c.started_at_ms !== null && finish !== null && finish > start ? finish - start : DEFAULT_DURATION_MS;
  return {
    case_id: c.case_id,
    seed: c.seed,
    family: c.family,
    outcome: c.result?.outcome ?? null,
    reason: c.result?.reason ?? null,
    startOffsetMs: start,
    durationMs,
    elbow: (c.seed & 1) === 0 ? 1 : -1,
  };
}

/**
 * Static geometry for one case. Every family's disturbance is set dressing that appears at
 * `disturbAt`, whatever the outcome, so a passing tile still shows what it had to cope with.
 */
export type Scene = {
  /** Target parcel centre at the start. */
  target: Pt;
  /** target_displacement: where the target slides to. */
  displacedTo: Pt | null;
  /** clutter_ambiguity: the look-alike parcel. */
  decoy: Pt | null;
  /** workspace_obstruction: a block on the transit path. */
  obstacle: Rect | null;
  /** visual_occlusion: a panel over the target. */
  occluder: Rect | null;
  bin: Rect;
  /** destination_change: where the bin moves to. */
  binMoved: Rect | null;
  /** Progress at which the disturbance happens. */
  disturbAt: number;
};

export function sceneFor(s: CellScript): Scene {
  const rnd = mulberry32(s.seed ^ 0x9e3779b9);
  const target = { x: 0.37 + (rnd() - 0.5) * 0.04, y: REST_Y };
  const f = s.family;
  return {
    target,
    displacedTo: f === "target_displacement" ? { x: target.x + 0.10, y: REST_Y } : null,
    decoy: f === "clutter_ambiguity" ? { x: target.x - 0.085, y: REST_Y } : null,
    obstacle: f === "workspace_obstruction" ? { x: 0.45, y: 0.45, w: 0.04, h: FLOOR_Y - 0.45 } : null,
    occluder: f === "visual_occlusion" ? { x: target.x - 0.055, y: 0.60, w: 0.11, h: FLOOR_Y - 0.60 } : null,
    bin: BIN,
    binMoved: f === "destination_change" ? { ...BIN, x: BIN.x + BIN_SHIFT } : null,
    disturbAt: f === "target_displacement" ? 0.16 : 0.2,
  };
}

const binCentre = (b: Rect): Pt => ({ x: b.x + b.w / 2, y: REST_Y });
export const insideBin = (p: Pt, b: Rect) => p.x - OBJ_W / 2 >= b.x - 1e-9 && p.x + OBJ_W / 2 <= b.x + b.w + 1e-9;

type Carry = "target" | "decoy" | null;
/** `t` is cumulative progress at this keyframe; the arm eases from the previous one. */
type Key = { t: number; at: Pt; grip: number; carry: Carry };
type Mark = { at: Pt; kind: "impact" | "miss" | "help"; from: number } | null;
type Plan = { keys: Key[]; mark: Mark; remap: (p: number) => number };

const above = (p: Pt, y = HOVER_Y): Pt => ({ x: p.x, y });
const grasp = (p: Pt): Pt => ({ x: p.x, y: p.y - GRASP_DY });
const key = (t: number, at: Pt, grip: number, carry: Carry = null): Key => ({ t, at, grip, carry });

/** Approach, grasp, lift, carry, place, return. `via` lifts the carry over an obstacle. */
function pickPlace(from: Pt, to: Pt, carry: Exclude<Carry, null>, via = HOVER_Y): Key[] {
  return [
    key(0, HOME, 1),
    key(0.14, above(from), 1),
    key(0.28, grasp(from), 1),
    key(0.36, grasp(from), 0, carry),
    key(0.46, above(from, via), 0, carry),
    key(0.68, above(to, via), 0, carry),
    key(0.82, grasp(to), 0, carry),
    key(0.88, grasp(to), 1),
    key(1, HOME, 1),
  ];
}

const identity = (p: number) => p;
const freezeAt = (q: number) => (p: number) => Math.min(p, q);
const hold = (keys: Key[], t = 1): Key[] => {
  const last = keys[keys.length - 1]!;
  return [...keys, { ...last, t }];
};

function plan(s: CellScript, sc: Scene): Plan {
  const bin = sc.binMoved ?? sc.bin;
  const nominal = pickPlace(sc.target, binCentre(bin), "target");
  const none: Mark = null;

  // Running: nominal motion, slowed so it never reaches a placement it has not earned.
  if (s.outcome === null) return { keys: nominal, mark: none, remap: (p) => p * 0.6 };

  switch (s.outcome) {
    case "PASS": {
      if (sc.displacedTo) {
        // The recovery the PRD wants seen: reach the stale spot, pause, re-target, complete.
        const stale = sc.target;
        const fresh = sc.displacedTo;
        const P = binCentre(bin);
        return {
          keys: [
            key(0, HOME, 1),
            key(0.12, above(stale), 1),
            key(0.22, grasp(stale), 1),
            key(0.28, grasp(stale), 1),
            key(0.36, above(fresh), 1),
            key(0.44, grasp(fresh), 1),
            key(0.50, grasp(fresh), 0, "target"),
            key(0.58, above(fresh), 0, "target"),
            key(0.74, above(P), 0, "target"),
            key(0.84, grasp(P), 0, "target"),
            key(0.90, grasp(P), 1),
            key(1, HOME, 1),
          ],
          mark: none,
          remap: identity,
        };
      }
      if (sc.obstacle) return { keys: pickPlace(sc.target, binCentre(bin), "target", HIGH_Y), mark: none, remap: identity };
      return { keys: nominal, mark: none, remap: identity };
    }
    case "FAIL":
      return failPlan(s.reason, sc, nominal);
    case "TIMEOUT":
      // Crawls: keeps issuing actions that barely move the arm, and never reaches the grasp.
      return { keys: nominal, mark: none, remap: (p) => (0.25 * (1 - Math.exp(-3 * p))) / (1 - Math.exp(-3)) };
    case "ESCALATED":
      return {
        keys: [key(0, HOME, 1), key(0.3, above(sc.target), 1), key(0.55, above(sc.target), 1), key(0.85, HOME, 1), key(1, HOME, 1)],
        mark: { at: { x: HOME.x + 0.07, y: HOME.y - 0.07 }, kind: "help", from: 0.55 },
        remap: identity,
      };
    case "UNKNOWN":
      return { keys: nominal, mark: none, remap: freezeAt(0.42) };
  }
}

function failPlan(reason: Reason | null, sc: Scene, nominal: Key[]): Plan {
  switch (reason) {
    case "TARGET_DISPLACED": {
      // Goes to where the target was, closes on air, stops. The cause is the stale spot itself.
      const stale = sc.target;
      return {
        keys: hold([key(0, HOME, 1), key(0.14, above(stale), 1), key(0.28, grasp(stale), 1), key(0.36, grasp(stale), 0)]),
        mark: { at: grasp(stale), kind: "miss", from: 0.36 },
        remap: identity,
      };
    }
    case "OBSTRUCTED": {
      const ob = sc.obstacle ?? { x: 0.45, y: 0.45, w: 0.04, h: FLOOR_Y - 0.45 };
      const contact = { x: ob.x - 0.015, y: HOVER_Y };
      return {
        keys: hold([...nominal.slice(0, 5), key(0.56, contact, 0, "target")]),
        mark: { at: { x: ob.x, y: HOVER_Y }, kind: "impact", from: 0.56 },
        remap: identity,
      };
    }
    case "WRONG_OBJECT":
      return { keys: pickPlace(sc.decoy ?? sc.target, binCentre(sc.binMoved ?? sc.bin), sc.decoy ? "decoy" : "target"), mark: null, remap: identity };
    case "INVALID_POSE":
      // Places at the bin's old position: the destination moved and the plan did not.
      return { keys: pickPlace(sc.target, binCentre(sc.bin), "target"), mark: null, remap: identity };
    case "NOT_VISIBLE":
      return {
        keys: hold([key(0, HOME, 1), key(0.2, above(sc.target), 1)]),
        mark: { at: above(sc.target, sc.occluder ? sc.occluder.y : HOVER_Y + 0.08), kind: "miss", from: 0.3 },
        remap: identity,
      };
    default:
      return { keys: nominal, mark: { at: HOME, kind: "miss", from: 0.5 }, remap: freezeAt(0.5) };
  }
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
  /** 1 open, 0 closed. */
  grip: number;
  carrying: Carry;
  target: Pt;
  decoy: Pt | null;
  /** Where the bin is drawn now (slides during a destination change). */
  bin: Rect;
  /** The bin's old position, once it has moved, so the stale destination stays legible. */
  binGhost: Rect | null;
  /** The disturbance has happened: occluder and obstacle are shown. */
  disturbed: boolean;
  /** The exact cause, drawn at the point of action. `strength` fades an impact. */
  mark: { at: Pt; kind: "impact" | "miss" | "help"; strength: number } | null;
};

/** Where the plan aims at progress p, and what it carries. */
function aim(keys: Key[], p: number): { at: Pt; grip: number; carry: Carry } {
  const i = Math.max(0, keys.findIndex((k) => k.t >= p) - 1);
  const from = keys[i]!;
  const to = keys[Math.min(i + 1, keys.length - 1)]!;
  const span = to.t - from.t;
  const k = span > 0 ? easeInOut(clamp((p - from.t) / span, 0, 1)) : 1;
  const carry = from.carry === to.carry ? from.carry : k > 0.5 ? to.carry : from.carry;
  return { at: lerpPt(from.at, to.at, k), grip: lerp(from.grip, to.grip, k), carry };
}

/** Where an object put down before progress p rests, or null if it has not been put down. */
function restingAt(keys: Key[], obj: Exclude<Carry, null>, p: number): Pt | null {
  let rest: Pt | null = null;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (a.carry === obj && b.carry !== obj && p >= (a.t + b.t) / 2) rest = { x: b.at.x, y: REST_Y };
  }
  return rest;
}

/** Full arm + scene state at progress p (0..1). Pure: same inputs, same pose, every time. */
export function poseAt(s: CellScript, sc: Scene, progress: number): Pose {
  const p = clamp(progress, 0, 1);
  const pl = plan(s, sc);
  const q = pl.remap(p);
  const a = aim(pl.keys, q);
  const { joint, tip, angle } = solve(a.at, s.elbow);
  const held = (obj: Exclude<Carry, null>, idle: Pt): Pt =>
    a.carry === obj ? { x: tip.x, y: tip.y + GRASP_DY } : restingAt(pl.keys, obj, q) ?? idle;

  // The disturbance runs on the case clock, not the arm's, so a crawling arm still sees it.
  const slide = clamp((p - sc.disturbAt) / 0.06, 0, 1);
  const idleTarget = sc.displacedTo ? lerpPt(sc.target, sc.displacedTo, easeInOut(slide)) : sc.target;
  const bin = sc.binMoved ? { ...sc.bin, x: lerp(sc.bin.x, sc.binMoved.x, easeInOut(slide)) } : sc.bin;

  let mark: Pose["mark"] = null;
  if (pl.mark && q >= pl.mark.from) {
    const strength = pl.mark.kind === "impact" ? Math.max(0.35, 1 - (q - pl.mark.from) / 0.15) : 1;
    mark = { at: pl.mark.at, kind: pl.mark.kind, strength };
  }

  return {
    joint,
    tip,
    angle,
    grip: a.grip,
    carrying: a.carry,
    target: held("target", idleTarget),
    decoy: sc.decoy ? held("decoy", sc.decoy) : null,
    bin,
    binGhost: sc.binMoved && slide > 0 ? sc.bin : null,
    disturbed: p >= sc.disturbAt,
    mark,
  };
}

/** Progress of one case at `elapsedMs` since the run started. Clamped to [0, 1]. */
export function progressAt(s: CellScript, elapsedMs: number): number {
  return clamp((elapsedMs - s.startOffsetMs) / s.durationMs, 0, 1);
}
