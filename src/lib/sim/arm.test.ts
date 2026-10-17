import test from "node:test";
import assert from "node:assert/strict";
import { BASE, L1, L2, FLOOR_Y, OBJ_R, poseAt, progressAt, scene, solve, type Pt } from "./arm";
import type { FailMode, Sim } from "../contract";

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

const sim = (over: Partial<Sim> = {}): Sim => ({
  id: "sim-000",
  seed: 12345,
  variant: { lighting: 0.5, friction: 1, objectDx: 0, objectDy: 0, distractors: 0, cameraJitter: 0 },
  status: "passed",
  startOffsetMs: 0,
  durationMs: 6000,
  elbow: 1,
  failMode: null,
  failAt: null,
  metrics: { reward: 0.9, steps: 120, graspAttempts: 1 },
  ...over,
});

test("solve reaches a goal inside the workspace", () => {
  for (const goal of [{ x: 0.4, y: 0.5 }, { x: 0.55, y: 0.7 }, { x: 0.3, y: 0.35 }]) {
    for (const elbow of [1, -1] as const) {
      const { tip } = solve(goal, elbow);
      assert.ok(dist(tip, goal) < 1e-6, `elbow ${elbow} missed ${JSON.stringify(goal)} by ${dist(tip, goal)}`);
    }
  }
});

test("solve keeps link lengths rigid, even for an unreachable goal", () => {
  const far = { x: 2, y: 2 };
  const { joint, tip } = solve(far, 1);
  assert.ok(Math.abs(dist(BASE, joint) - L1) < 1e-9, "upper link stretched");
  assert.ok(Math.abs(dist(joint, tip) - L2) < 1e-9, "forearm stretched");
  // Saturated: extended as far toward the goal as the arm can go.
  assert.ok(dist(BASE, tip) > L1 + L2 - 1e-3);
});

test("elbow sign actually bends the arm the other way", () => {
  const goal = { x: 0.5, y: 0.55 };
  assert.ok(dist(solve(goal, 1).joint, solve(goal, -1).joint) > 0.05, "both elbows produced the same pose");
});

test("poseAt is pure: the same progress always gives the same pose", () => {
  const s = sim();
  const sc = scene(s);
  for (const p of [0, 0.2, 0.47, 0.8, 1]) {
    assert.deepEqual(poseAt(s, sc, p), poseAt(s, sc, p));
  }
});

test("a clean rollout carries the object and lands it in the bin", () => {
  const s = sim();
  const sc = scene(s);
  assert.equal(poseAt(s, sc, 0.1).holding, false, "should not hold before the grasp");
  assert.equal(poseAt(s, sc, 0.6).holding, true, "should hold during transit");
  const end = poseAt(s, sc, 1);
  assert.equal(end.landedInBin, true);
  assert.ok(dist(end.object, sc.place) < 1e-9, "object did not come to rest at the bin");
});

test("the carried object tracks the gripper", () => {
  const s = sim();
  const sc = scene(s);
  const mid = poseAt(s, sc, 0.6);
  assert.ok(dist(mid.object, mid.tip) < OBJ_R, "object detached from the gripper mid-transit");
});

test("grasp_slip drops the object and it falls to the floor", () => {
  const s = sim({ status: "failed", failMode: "grasp_slip", failAt: 0.55 });
  const sc = scene(s);
  assert.equal(poseAt(s, sc, 0.5).holding, true, "should still hold before the slip");
  assert.equal(poseAt(s, sc, 0.6).holding, false, "should have let go after the slip");
  const end = poseAt(s, sc, 1);
  assert.equal(end.landedInBin, false);
  assert.ok(Math.abs(end.object.y - (FLOOR_Y - OBJ_R)) < 1e-6, `object rested at y=${end.object.y}, not the floor`);
});

test("the object falls monotonically once dropped", () => {
  const s = sim({ status: "failed", failMode: "grasp_slip", failAt: 0.5 });
  const sc = scene(s);
  let last = -Infinity;
  for (let p = 0.5; p <= 1; p += 0.02) {
    const y = poseAt(s, sc, p).object.y;
    assert.ok(y >= last - 1e-9, `object rose at p=${p.toFixed(2)}`);
    last = y;
  }
});

test("missed_approach never grasps and leaves the object where it started", () => {
  const s = sim({ status: "failed", failMode: "missed_approach", failAt: 0.35 });
  const sc = scene(s);
  for (const p of [0.3, 0.5, 0.8, 1]) {
    assert.equal(poseAt(s, sc, p).holding, false, `grasped at p=${p}`);
  }
  assert.deepEqual(poseAt(s, sc, 1).object, sc.pick);
  // It reached for the wrong place, which is the whole point of the failure.
  assert.ok(poseAt(s, sc, 0.3).tip.x > poseAt(sim(), sc, 0.3).tip.x);
});

test("collision freezes the arm at the point of contact", () => {
  const s = sim({ status: "failed", failMode: "collision", failAt: 0.25, durationMs: 6000 });
  const sc = scene(s);
  const atImpact = poseAt(s, sc, 0.25);
  for (const p of [0.4, 0.7, 1]) {
    const later = poseAt(s, sc, p);
    assert.ok(dist(later.tip, atImpact.tip) < 1e-9, `arm kept moving after the collision at p=${p}`);
  }
  assert.ok(poseAt(s, sc, 0.26).impact > 0, "no impact shake");
  assert.equal(poseAt(s, sc, 1).impact, 0, "shake should have decayed");
});

test("timeout crawls and never reaches the bin", () => {
  const s = sim({ status: "failed", failMode: "timeout", failAt: 0.4, durationMs: 12000 });
  const sc = scene(s);
  const end = poseAt(s, sc, 1);
  assert.equal(end.landedInBin, false);
  assert.equal(end.holding, false);
});

test("every failure mode produces a pose at every frame", () => {
  const modes: FailMode[] = ["collision", "grasp_slip", "missed_approach", "dropped_outside", "timeout"];
  for (const failMode of modes) {
    const s = sim({ status: "failed", failMode, failAt: 0.45 });
    const sc = scene(s);
    for (let p = 0; p <= 1; p += 0.05) {
      const pose = poseAt(s, sc, p);
      for (const [k, v] of Object.entries({ jx: pose.joint.x, jy: pose.joint.y, tx: pose.tip.x, ty: pose.tip.y, ox: pose.object.x, oy: pose.object.y })) {
        assert.ok(Number.isFinite(v), `${failMode} produced a non-finite ${k} at p=${p.toFixed(2)}`);
      }
    }
  }
});

test("scene places clutter on the floor and honours the object offset", () => {
  const s = sim({ variant: { ...sim().variant, objectDx: 1, distractors: 4 } });
  const sc = scene(s);
  assert.equal(sc.distractors.length, 4);
  for (const d of sc.distractors) assert.ok(d.y > 0.7 && d.y < FLOOR_Y, `distractor floated at y=${d.y}`);
  assert.ok(sc.pick.x > scene(sim()).pick.x, "objectDx did not shift the object");
});

test("progressAt maps the run clock onto a rollout's own window", () => {
  const s = sim({ startOffsetMs: 1000, durationMs: 4000 });
  assert.equal(progressAt(s, 0), 0);
  assert.equal(progressAt(s, 1000), 0);
  assert.equal(progressAt(s, 3000), 0.5);
  assert.equal(progressAt(s, 5000), 1);
  assert.equal(progressAt(s, 99999), 1, "progress must clamp, not overrun");
});
