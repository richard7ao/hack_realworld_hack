import test from "node:test";
import assert from "node:assert/strict";
import { difficultyOf, failModeFor, freeze, generateRun } from "./generate";
import { Run } from "../contract";
import { mulberry32 } from "../rng";
import { tally } from "../score";

const base = { id: "run-test", environmentId: "kitchen-counter", task: "Pick up the red mug", fanout: 100 };

test("a generated run satisfies the contract schema", () => {
  assert.doesNotThrow(() => Run.parse(generateRun(base)));
});

test("generation is deterministic: the same id gives byte-identical rollouts", () => {
  const a = generateRun(base);
  const b = generateRun(base);
  assert.deepEqual(a.sims, b.sims);
});

test("a different run id gives different rollouts", () => {
  assert.notDeepEqual(generateRun(base).sims, generateRun({ ...base, id: "run-other" }).sims);
});

test("fan-out produces exactly that many uniquely identified rollouts", () => {
  const run = generateRun({ ...base, fanout: 64 });
  assert.equal(run.sims.length, 64);
  assert.equal(new Set(run.sims.map((s) => s.id)).size, 64);
});

test("the pass rate lands near the requested skill, across seeds and environments", () => {
  for (const environmentId of ["kitchen-counter", "warehouse-shelf", "lab-bench", "cluttered-desk"]) {
    for (const skill of [0.7, 0.87]) {
      for (let k = 0; k < 3; k++) {
        const run = generateRun({ ...base, id: `r-${environmentId}-${skill}-${k}`, environmentId, skill });
        const rate = tally(run.sims).passed / run.sims.length;
        assert.ok(Math.abs(rate - skill) < 0.11, `${environmentId} skill=${skill} seed=${k} gave ${rate.toFixed(2)}`);
      }
    }
  }
});

test("failures are caused by difficulty, not drawn at random", () => {
  const run = generateRun({ ...base, fanout: 400 });
  const avg = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / Math.max(1, xs.length);
  const hard = avg(run.sims.filter((s) => s.status === "failed").map((s) => difficultyOf(s.variant)));
  const easy = avg(run.sims.filter((s) => s.status === "passed").map((s) => difficultyOf(s.variant)));
  assert.ok(hard > easy + 0.05, `failed rollouts averaged ${hard.toFixed(3)} difficulty vs ${easy.toFixed(3)} for passes`);
});

test("every failed rollout carries both a mode and a point of failure", () => {
  for (const s of generateRun({ ...base, fanout: 200, skill: 0.6 }).sims) {
    if (s.status === "failed") {
      assert.ok(s.failMode, `${s.id} failed with no mode`);
      assert.ok(s.failAt !== null && s.failAt > 0 && s.failAt < 1, `${s.id} has failAt ${s.failAt}`);
    } else {
      assert.equal(s.failMode, null);
      assert.equal(s.failAt, null);
    }
  }
});

test("failModeFor blames the condition that was actually extreme", () => {
  const rnd = mulberry32(7);
  const nominal = { lighting: 0.55, friction: 1.0, objectDx: 0, objectDy: 0, distractors: 0, cameraJitter: 0 };
  const draw = (over: Partial<typeof nominal>) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const m = failModeFor(rnd, { ...nominal, ...over });
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  };
  assert.equal(draw({ distractors: 6 }), "collision", "heavy clutter should mostly collide");
  assert.equal(draw({ friction: 0.35 }), "grasp_slip", "a slippery object should mostly slip");
  assert.equal(draw({ objectDx: 1, objectDy: 1, cameraJitter: 0.9 }), "missed_approach", "a badly localised object should be missed");
});

test("freeze hides the outcome of rollouts that have not settled", () => {
  const run = generateRun(base);
  const frozen = freeze(run, 3000);
  for (const s of frozen.sims) {
    const settled = s.status === "passed" || s.status === "failed";
    assert.equal(settled, 3000 >= s.startOffsetMs + s.durationMs, `${s.id} settled state disagrees with the clock`);
    if (s.status === "running" || s.status === "queued" || s.status === "booting") {
      const detected = s.startOffsetMs + (run.sims.find((o) => o.id === s.id)!.failAt ?? 1) * s.durationMs;
      if (3000 < detected) assert.equal(s.failMode, null, `${s.id} leaked its outcome before the harness could know it`);
    }
  }
});

test("freeze at zero means nothing has run and nothing is claimed", () => {
  const frozen = freeze(generateRun(base), 0);
  assert.equal(tally(frozen.sims).settled, 0);
  assert.equal(frozen.stage, "provisioning");
  assert.doesNotThrow(() => Run.parse(frozen));
});

test("freeze past the end is the completed run", () => {
  const run = generateRun(base);
  const frozen = freeze(run, 1e9);
  assert.deepEqual(frozen.sims, run.sims);
  assert.equal(frozen.stage, "scoring");
});

test("an unknown environment falls back rather than throwing mid-demo", () => {
  const run = generateRun({ ...base, environmentId: "does-not-exist" });
  assert.equal(run.environmentId, "kitchen-counter");
});
