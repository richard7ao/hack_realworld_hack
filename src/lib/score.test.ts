import test from "node:test";
import assert from "node:assert/strict";
import { bucketBy, clutterLabel, CLUTTER_ORDER, evaluateGate, failureBreakdown, median, tally, wilson } from "./score";
import type { Gate, Sim } from "./contract";

const sim = (over: Partial<Sim> = {}): Sim => ({
  id: "sim-000", seed: 1,
  variant: { lighting: 0.5, friction: 1, objectDx: 0, objectDy: 0, distractors: 0, cameraJitter: 0 },
  status: "passed", startOffsetMs: 0, durationMs: 6000, elbow: 1,
  failMode: null, failAt: null, metrics: { reward: 0.9, steps: 120, graspAttempts: 1 },
  ...over,
});
const pass = (n: number) => Array.from({ length: n }, (_, i) => sim({ id: `p${i}` }));
const fail = (n: number, mode: Sim["failMode"] = "collision") =>
  Array.from({ length: n }, (_, i) => sim({ id: `f${i}`, status: "failed", failMode: mode, failAt: 0.3 }));
const queued = (n: number) => Array.from({ length: n }, (_, i) => sim({ id: `q${i}`, status: "queued" }));

const gate = (over: Partial<Gate> = {}): Gate => ({
  metric: "pass_rate", threshold: 0.8, regressionTolerancePp: 2,
  baseline: { ref: "main@7d21e0b", passRate: 0.82, n: 100 }, ...over,
});

test("tally separates settled rollouts from those still in flight", () => {
  const t = tally([...pass(3), ...fail(2), sim({ status: "running" }), sim({ status: "booting" }), sim({ status: "queued" })]);
  assert.deepEqual(t, { passed: 3, failed: 2, settled: 5, inFlight: 2, booting: 1, running: 1, queued: 1 });
});

test("tally distinguishes booting from running, because the two are different steps to narrate", () => {
  const t = tally([sim({ status: "booting" }), sim({ status: "booting" }), sim({ status: "running" })]);
  assert.equal(t.booting, 2);
  assert.equal(t.running, 1);
  assert.equal(t.inFlight, 3, "both still count as in flight");
});

test("wilson brackets the point estimate and stays inside [0,1]", () => {
  const { lo, hi } = wilson(87, 100);
  assert.ok(lo < 0.87 && hi > 0.87, `interval ${lo}-${hi} excludes the estimate`);
  assert.ok(lo >= 0 && hi <= 1);
  // At n=100 a 90% interval is roughly +/-6pp, so the lower bound sits just above 0.80.
  assert.ok(lo > 0.79 && lo < 0.83, `lower bound ${lo} outside the expected range`);
});

test("wilson stays inside [0,1] at the extremes, where the normal approximation does not", () => {
  for (const [k, n] of [[0, 5], [5, 5], [0, 1], [1, 1]] as const) {
    const { lo, hi } = wilson(k, n);
    assert.ok(lo >= 0 && hi <= 1, `wilson(${k},${n}) gave ${lo}-${hi}`);
  }
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1 }, "no data must mean no claim");
});

test("the gate passes only when the run clears the floor AND has not regressed", () => {
  // 87/100: lower bound ~80.6% clears 80%, and +5pp on baseline.
  const v = evaluateGate([...pass(87), ...fail(13)], gate());
  assert.equal(v.status, "pass");
  assert.ok(v.checks.every((c) => c.ok));
});

test("the gate fails a run that regressed against baseline even while clearing the floor", () => {
  // 79/100 vs an 82% baseline: 3pp down, past the 2pp tolerance.
  const v = evaluateGate([...pass(79), ...fail(21)], gate({ threshold: 0.5 }));
  assert.equal(v.status, "fail");
  assert.equal(v.checks.find((c) => c.id === "floor")?.ok, true);
  assert.equal(v.checks.find((c) => c.id === "regression")?.ok, false);
});

test("the gate fails a run whose interval is too wide to clear the floor, even at a good point estimate", () => {
  // 9/10 is 90%, but with n=10 the lower bound is far below 80%: not enough evidence.
  const v = evaluateGate([...pass(9), ...fail(1)], gate({ baseline: null }));
  assert.equal(v.passRate, 0.9);
  assert.equal(v.status, "fail", "a small sample must not go green on noise");
  assert.equal(v.checks.find((c) => c.id === "floor")?.ok, false);
});

test("the gate is pending, not failing, before anything has settled", () => {
  const v = evaluateGate([sim({ status: "running" }), ...queued(99)], gate());
  assert.equal(v.status, "pending");
  assert.equal(v.n, 0);
});

test("a perfect record five rollouts in is pending, because five passes cannot prove a 100-rollout floor", () => {
  // The bug this guards: wilson(5,5) has a lower bound near 57%, which is below the 80% floor. Read
  // as a verdict that renders a red "100% PASS RATE" on a run that has barely started.
  const v = evaluateGate([...pass(5), ...queued(95)], gate());
  assert.equal(v.status, "pending");
  assert.notEqual(v.status, "fail");
});

test("a pending gate reports its checks as undetermined, so the UI cannot claim a check has failed", () => {
  const v = evaluateGate([...pass(5), ...queued(95)], gate());
  assert.deepEqual(v.checks.map((c) => c.ok), [null, null]);
  // The live numbers stay on show while undetermined: watching them is the point of a running bench.
  assert.ok(v.checks.every((c) => c.detail.length > 0));
});

test("a pending gate's passRate and n describe the settled rollouts only, not the whole fan-out", () => {
  const v = evaluateGate([...pass(4), ...fail(1), ...queued(95)], gate());
  assert.equal(v.n, 5, "n counts settled rollouts, not the 100 fanned out");
  assert.equal(v.passRate, 0.8);
});

test("the gate fails fast once the floor is unreachable, rather than burning the remaining compute", () => {
  // 15 passed, 25 failed, 60 outstanding. Best case 75/100, whose lower bound is about 67%: even if
  // every rollout left were to pass, the run could not clear 80%. There is nothing left to wait for.
  const v = evaluateGate([...pass(15), ...fail(25), ...queued(60)], gate());
  assert.equal(v.status, "fail");
  assert.equal(v.checks.find((c) => c.id === "floor")?.ok, false);
  // The regression check is still undetermined: a partial pass rate concludes nothing against baseline.
  assert.equal(v.checks.find((c) => c.id === "regression")?.ok, null);
});

test("a partial run that could still land either side of the floor stays pending", () => {
  // 45 passed, 5 failed, 50 outstanding. Best case 95/100 clears the floor, so the run is live.
  const v = evaluateGate([...pass(45), ...fail(5), ...queued(50)], gate());
  assert.equal(v.status, "pending");
});

test("a fan-out too small to ever clear the floor fails immediately, because it cannot produce the evidence", () => {
  // Two rollouts, both outstanding. Even 2/2 gives a lower bound near 43%, so 80% is unreachable.
  const v = evaluateGate([sim({ status: "running" }), sim({ status: "queued" })], gate());
  assert.equal(v.status, "fail");
});

test("a fully settled run keeps the verdict it had before partial runs were made pending", () => {
  assert.equal(evaluateGate([...pass(87), ...fail(13)], gate()).status, "pass");
  assert.equal(evaluateGate([...pass(79), ...fail(21)], gate({ threshold: 0.5 })).status, "fail");
  assert.equal(evaluateGate([...pass(9), ...fail(1)], gate({ baseline: null })).status, "fail");
});

test("a run with no baseline is judged on the floor alone", () => {
  const v = evaluateGate([...pass(87), ...fail(13)], gate({ baseline: null }));
  assert.equal(v.checks.length, 1);
  assert.equal(v.status, "pass");
});

test("failureBreakdown counts only failures, sorted, with zeroes dropped", () => {
  const rows = failureBreakdown([...pass(5), ...fail(3, "collision"), ...fail(7, "grasp_slip")]);
  assert.deepEqual(rows, [{ mode: "grasp_slip", count: 7 }, { mode: "collision", count: 3 }]);
});

test("bucketBy ignores unsettled rollouts so partial runs are not reported as failures", () => {
  const rows = bucketBy(
    [sim(), sim({ status: "failed", failMode: "collision" }), sim({ status: "running" })],
    clutterLabel,
    CLUTTER_ORDER,
  );
  const zero = rows.find((r) => r.label === "0 distractors")!;
  assert.deepEqual({ n: zero.n, passed: zero.passed }, { n: 2, passed: 1 });
});

test("median handles even, odd and empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});
