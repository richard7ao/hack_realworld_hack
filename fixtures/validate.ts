/**
 * Parses every fixture with the schema the frontend will parse it with, so a fixture can never be
 * the reason a screen breaks during a demo. Also asserts the fixtures actually cover the states the
 * UI has to render: a green gate, a red gate, a run still in flight, and every failure mode.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endpoints, FAIL_MODES, Run, type EndpointName } from "../src/lib/contract";
import { evaluateGate } from "../src/lib/score";

const here = import.meta.dirname;
const read = (name: string): unknown => JSON.parse(readFileSync(join(here, `${name}.json`), "utf8"));
const problems: string[] = [];
const check = (ok: boolean, message: string) => { if (!ok) problems.push(message); };

for (const [name, ep] of Object.entries(endpoints) as [EndpointName, (typeof endpoints)[EndpointName]][]) {
  const raw = read(ep.fixture);
  const items = "pickBy" in ep ? (raw as unknown[]) : [raw];
  if ("pickBy" in ep) check(Array.isArray(raw), `${ep.fixture}.json must be an array for pickBy lookups`);
  for (const item of items) {
    const parsed = ep.response.safeParse(item);
    check(parsed.success, `${name}: ${ep.fixture}.json failed its schema\n${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 4), null, 2)}`);
  }
  console.log(`ok  ${name.padEnd(14)} <- fixtures/${ep.fixture}.json (${items.length})`);
}

const runs = (read("runs") as unknown[]).map((r) => Run.parse(r));
const byId = new Map(runs.map((r) => [r.id, r]));

check(byId.has("run-demo"), "fixtures/runs.json is missing run-demo, the default fixture run");
check(evaluateGate(byId.get("run-demo")!.sims, byId.get("run-demo")!.gate).status === "pass", "run-demo must pass its gate: it is the happy-path demo");
check(evaluateGate(byId.get("run-regression")!.sims, byId.get("run-regression")!.gate).status === "fail", "run-regression must fail its gate, or the gate is decoration");
check(byId.get("run-live")!.sims.some((s) => s.status === "running"), "run-live must have rollouts in flight to exercise the polling path");
check(byId.get("run-live")!.sims.some((s) => s.status === "queued"), "run-live must have queued rollouts to exercise the queued cell state");

const seen = new Set(runs.flatMap((r) => r.sims.map((s) => s.failMode)).filter(Boolean));
for (const mode of FAIL_MODES) check(seen.has(mode), `no fixture rollout fails with "${mode}", so that cell animation is never exercised`);

for (const run of runs) {
  check(run.sims.length === run.fanout, `${run.id}: ${run.sims.length} rollouts for a fan-out of ${run.fanout}`);
  check(new Set(run.sims.map((s) => s.id)).size === run.sims.length, `${run.id}: duplicate rollout ids`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`\nall fixtures valid (${runs.length} runs, ${runs.reduce((s, r) => s + r.sims.length, 0)} rollouts)`);
