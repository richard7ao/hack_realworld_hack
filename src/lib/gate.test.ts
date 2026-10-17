import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GATE, evaluateGate, summarize } from "./gate";
import type { Benchmark, BenchmarkCase, Family, Outcome, Reason } from "./contract";

/**
 * The gate is the product's verdict. These tests pin the behaviour the PRD makes non-negotiable:
 * per-case comparison, blocking on regressions even when the aggregate improves, and an honest
 * INSUFFICIENT_EVIDENCE when there is not enough to decide.
 */
const FAM: Family = "target_displacement";

const kase = (id: string, outcome: Outcome | null, reason: Reason | null = null, violations: string[] = [], family: Family = FAM): BenchmarkCase => ({
  case_id: id,
  family,
  seed: 1,
  status: outcome ? "done" : "pending",
  started_at_ms: outcome ? 0 : null,
  finished_at_ms: outcome ? 1000 : null,
  result: outcome && {
    case_id: id, policy_version: "p", outcome, reason, task_success: outcome === "PASS", constraint_violations: violations,
    actions: 4, recovery_attempts: 0, sim_elapsed_ms: 900, wall_elapsed_ms: 1000, trace_ref: null, evaluator_version: "oracle_v1",
  },
});

const run = (id: string, cases: BenchmarkCase[]): Benchmark => ({
  run_id: id, created_at: "2026-10-17T12:00:00.000Z", suite: "PickLab-100", source: "demo_fixture", status: "done",
  policy: { policy_id: id, adapter_type: "scripted", model: null, prompt_version: null, observation_modalities: [], action_space: "symbolic_v1", max_actions: 12 },
  evaluator_version: "oracle_v1", concurrency: 10, cases,
});

/** n cases with ids c0..c(n-1), outcome chosen per index. */
const many = (n: number, at: (i: number) => [Outcome, Reason | null, string[]?]) =>
  Array.from({ length: n }, (_, i) => { const [o, r, v] = at(i); return kase(`c${i}`, o, r, v ?? []); });

test("a candidate that raises the pass rate is still blocked for the cases it broke", () => {
  // Baseline: 80/100, failing c80..c99. Candidate fixes all twenty but breaks c0..c2 by grasping the wrong object.
  const base = run("base", many(100, (i) => (i >= 80 ? ["FAIL", "TARGET_DISPLACED"] : ["PASS", null])));
  const cand = run("cand", many(100, (i) => (i < 3 ? ["FAIL", "WRONG_OBJECT", ["wrong_object_grasp_attempt"]] : ["PASS", null])));
  const g = evaluateGate(base, cand);
  assert.ok(g.candidate.passed > g.baseline.passed, "precondition: the aggregate improved");
  assert.equal(g.decision, "BLOCK");
  assert.deepEqual(g.critical_regressions, ["c0", "c1", "c2"]);
  assert.equal(g.fixed.length, 20);
});

test("a hard safety violation blocks even when there are too few cases to judge anything else", () => {
  const g = evaluateGate(run("b", many(5, () => ["PASS", null])), run("c", many(5, (i) => (i === 0 ? ["FAIL", "OBSTRUCTED", ["forbidden_collision"]] : ["PASS", null]))));
  assert.equal(g.decision, "BLOCK", "one collision is evidence enough");
});

test("too few eligible cases is INSUFFICIENT_EVIDENCE, neither a pass nor a block", () => {
  const g = evaluateGate(run("b", many(10, () => ["PASS", null])), run("c", many(10, () => ["PASS", null])));
  assert.equal(g.decision, "INSUFFICIENT_EVIDENCE");
});

test("UNKNOWN is executed but not eligible, so it cannot pad the evidence count", () => {
  const c = run("c", many(60, (i) => (i < 20 ? ["UNKNOWN", null] : ["PASS", null])));
  const s = summarize(c);
  assert.equal(s.executed, 60);
  assert.equal(s.eligible, 40);
  assert.equal(evaluateGate(c, c).decision, "INSUFFICIENT_EVIDENCE");
});

test("ESCALATED is never counted as a pass", () => {
  const c = run("c", many(100, (i) => (i < 30 ? ["ESCALATED", null] : ["PASS", null])));
  const g = evaluateGate(c, c);
  assert.equal(g.candidate.passed, 70);
  assert.equal(g.decision, "BLOCK", "70% is below the 80% completion threshold");
});

test("a clean candidate above threshold passes, and non-critical regressions are still listed", () => {
  const base = run("b", many(100, (i) => (i >= 90 ? ["FAIL", "TARGET_DISPLACED"] : ["PASS", null])));
  const cand = run("c", many(100, (i) => (i === 0 ? ["TIMEOUT", "TIMEOUT"] : ["PASS", null])));
  const g = evaluateGate(base, cand);
  assert.equal(g.decision, "PASS");
  assert.deepEqual(g.regressed, ["c0"], "the timeout regression is visible even though it does not block");
  assert.deepEqual(g.critical_regressions, []);
});

test("below the completion threshold blocks", () => {
  const g = evaluateGate(run("b", many(100, () => ["PASS", null])), run("c", many(100, (i) => (i < 25 ? ["FAIL", "TARGET_DISPLACED"] : ["PASS", null]))));
  assert.equal(g.decision, "BLOCK");
  assert.equal(g.rules.find((r) => r.id === "completion")?.ok, false);
});

test("only cases both runs executed are compared, so an unrun case is never a fix or a regression", () => {
  const base = run("b", [kase("a", "PASS"), kase("b", null)]);
  const cand = run("c", [kase("a", "PASS"), kase("b", "FAIL", "TARGET_DISPLACED")]);
  const g = evaluateGate(base, cand);
  assert.deepEqual([g.fixed, g.regressed, g.still_failing], [[], [], []]);
});

test("the gate is deterministic for the same inputs", () => {
  const b = run("b", many(60, (i) => (i % 7 === 0 ? ["FAIL", "NOT_VISIBLE"] : ["PASS", null])));
  const c = run("c", many(60, (i) => (i % 5 === 0 ? ["FAIL", "WRONG_OBJECT"] : ["PASS", null])));
  const at = new Date("2026-10-17T12:00:00Z");
  assert.deepEqual(evaluateGate(b, c, DEFAULT_GATE, at), evaluateGate(b, c, DEFAULT_GATE, at));
});
