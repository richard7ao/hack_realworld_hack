/**
 * Regenerates fixtures/*.json from the deterministic generator. Run with `pnpm fixtures:build`
 * whenever the contract or the generator changes, then commit the output: the committed JSON is
 * what the frontend serves in fixture mode and what the backend team diffs against.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENVIRONMENTS } from "../src/lib/sim/environments";
import { freeze, generateRun } from "../src/lib/sim/generate";
import { evaluateGate } from "../src/lib/score";

const here = import.meta.dirname;
const write = (name: string, data: unknown) => {
  writeFileSync(join(here, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote fixtures/${name}.json`);
};

/** The headline demo: a healthy policy that clears the gate. */
const green = generateRun({
  id: "run-demo",
  environmentId: "kitchen-counter",
  task: "Pick up the red mug and place it on the tray",
  fanout: 100,
  skill: 0.85,
});

/** The same fan-out, caught 9 s in: wave one settled, wave two running, the rest queued. */
const live = freeze(
  generateRun({ id: "run-live", environmentId: "warehouse-shelf", task: "Pick the labelled carton from the middle bin", fanout: 100, skill: 0.84 }),
  9000,
);

/** A regression: the gate must go red, or the bench is decoration. */
const red = generateRun({
  id: "run-regression",
  environmentId: "cluttered-desk",
  task: "Pick up the stapler without snagging the cables",
  fanout: 100,
  skill: 0.71,
  policy: { name: "pi0-fast", commit: "9b02e41", branch: "feat/vision-swap" },
});

write("environments", { environments: ENVIRONMENTS });
write("run-created", { ok: true, runId: green.id, error: null });
write("runs", [green, live, red]);

for (const run of [green, live, red]) {
  const v = evaluateGate(run.sims, run.gate);
  console.log(`  ${run.id.padEnd(16)} ${run.stage.padEnd(12)} ${(v.passRate * 100).toFixed(1)}% n=${v.n} -> ${v.status.toUpperCase()}`);
}
