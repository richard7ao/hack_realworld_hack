import test from "node:test";
import assert from "node:assert/strict";
import { cellStateAt, runLengthMs, simsAt } from "./replay";
import { tally } from "./score";
import type { Sim } from "./contract";

const sim = (over: Partial<Sim> = {}): Sim => ({
  id: "sim-000", seed: 1,
  variant: { lighting: 0.5, friction: 1, objectDx: 0, objectDy: 0, distractors: 0, cameraJitter: 0 },
  status: "passed", startOffsetMs: 2000, durationMs: 5000, elbow: 1,
  failMode: null, failAt: null, metrics: { reward: 0.9, steps: 100, graspAttempts: 1 },
  ...over,
});

test("a cell walks queued -> booting -> running -> settled on the run clock", () => {
  const s = sim();
  assert.equal(cellStateAt(s, 0), "queued");
  assert.equal(cellStateAt(s, 1400), "queued");
  assert.equal(cellStateAt(s, 1700), "booting");
  assert.equal(cellStateAt(s, 2500), "running");
  assert.equal(cellStateAt(s, 6999), "running");
  assert.equal(cellStateAt(s, 7000), "passed");
});

test("a rollout the backend still calls running past its window reads as an overrun, not a pass", () => {
  assert.equal(cellStateAt(sim({ status: "running" }), 99999), "running");
  assert.equal(cellStateAt(sim({ status: "queued" }), 99999), "running");
});

test("simsAt never reveals an outcome the clock has not reached", () => {
  const sims = [sim({ id: "a" }), sim({ id: "b", status: "failed", failMode: "grasp_slip", failAt: 0.5 })];
  const early = simsAt(sims, 3000);
  assert.equal(tally(early).settled, 0, "nothing should be settled 1s into a 5s episode");
  assert.equal(early[1]!.failMode, null, "the failure mode leaked before the harness could detect it");
  // failAt 0.5 of a 5000ms episode starting at 2000 => detected at 4500ms.
  assert.equal(simsAt(sims, 4600)[1]!.failMode, "grasp_slip", "the mode should surface once detected");
  assert.equal(simsAt(sims, 4600)[1]!.status, "running", "detected is not the same as finished");
  assert.equal(tally(simsAt(sims, 7000)).settled, 2);
});

test("runLengthMs is the slowest rollout's finish", () => {
  assert.equal(runLengthMs([sim({ startOffsetMs: 0, durationMs: 1000 }), sim({ startOffsetMs: 4000, durationMs: 2000 })]), 6000);
  assert.equal(runLengthMs([]), 0);
});
