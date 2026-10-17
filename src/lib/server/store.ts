import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Benchmark, BenchmarkList, type CaseDetail, type GateResult, type RerunResponse } from "../contract";
import { evaluateGate } from "../gate";
import { generateBenchmark, generateCaseDetail, POLICIES, rerunCase } from "../sim/generate";
import type { z } from "zod";

/**
 * Fixture-mode backend. Server only.
 *
 * Serves the committed demo runs, labelled `source: "demo_fixture"`, and computes case detail,
 * reruns and the gate from the same deterministic engine, so every screen agrees with every other.
 * Runs started from the UI are generated on demand and kept in memory; an unknown run id is a 404,
 * never a silently substituted run.
 */
const FIXTURES = join(process.cwd(), "fixtures");

export class NotFound extends Error {}

let committed: Map<string, Benchmark> | null = null;
function fixtures(): Map<string, Benchmark> {
  if (!committed) {
    const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, "benchmarks.json"), "utf8"));
    committed = new Map(Benchmark.array().parse(raw).map((b) => [b.run_id, b]));
  }
  return committed;
}

const started = new Map<string, Benchmark>();

export function getBenchmark(runId: string): Benchmark {
  const run = started.get(runId) ?? fixtures().get(runId);
  if (!run) throw new NotFound(`No benchmark run "${runId}".`);
  return run;
}

export function listBenchmarks(): z.infer<typeof BenchmarkList> {
  const runs = [...fixtures().values(), ...started.values()];
  return {
    benchmarks: runs.map((r) => ({ run_id: r.run_id, policy_id: r.policy.policy_id, source: r.source, status: r.status, created_at: r.created_at })),
    policies: POLICIES,
  };
}

export function runBenchmark(policyId: string): { run_id: string } {
  if (!POLICIES.some((p) => p.policy_id === policyId)) throw new NotFound(`Unknown policy "${policyId}".`);
  const run_id = `bench-${policyId}-${Date.now().toString(36)}`;
  started.set(run_id, generateBenchmark({ run_id, policy_id: policyId, created_at: new Date().toISOString() }));
  if (started.size > 30) started.delete(started.keys().next().value!);
  return { run_id };
}

export function getCaseDetail(runId: string, caseId: string): CaseDetail {
  const run = getBenchmark(runId);
  if (!run.cases.some((c) => c.case_id === caseId)) throw new NotFound(`No case "${caseId}" in "${runId}".`);
  return generateCaseDetail(run, caseId);
}

export function rerun(caseId: string, policyId: string): z.infer<typeof RerunResponse> {
  if (!POLICIES.some((p) => p.policy_id === policyId)) throw new NotFound(`Unknown policy "${policyId}".`);
  const { result, trace } = rerunCase(caseId, policyId);
  return { run_id: `rerun-${caseId}-${policyId}`, case_id: caseId, result, trace };
}

export function gate(baselineId: string, candidateId: string): GateResult {
  return evaluateGate(getBenchmark(baselineId), getBenchmark(candidateId));
}

export function scenario(caseId: string) {
  // A scenario depends only on its case id, so any committed run can supply it.
  const first = [...fixtures().values()][0];
  if (!first || !first.cases.some((c) => c.case_id === caseId)) throw new NotFound(`No scenario "${caseId}".`);
  return generateCaseDetail(first, caseId).scenario;
}
