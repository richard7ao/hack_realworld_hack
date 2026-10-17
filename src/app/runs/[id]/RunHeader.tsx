"use client";
import type { Run } from "../../../lib/contract";
import type { Tally } from "../../../lib/score";
import { Counter } from "../../../components/ui";
import { STEPS, stepFor } from "./stage";

/** Step eyebrow, page title, and the counter that carries the run's progress on its own. */
export function RunHeader({ run, tally, elapsedMs }: { run: Run; tally: Tally; elapsedMs: number }) {
  const step = stepFor(tally, run, elapsedMs);
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        <p className="eyebrow">Step {step.index + 1} of {STEPS.length} · {STEPS[step.index]}</p>
        <h1 key={step.title} className="h2 a-blur-in mt-2.5 text-[34px] md:text-[44px]">{step.title}</h1>
        <p className="mt-2 text-[15px] text-muted">{step.detail}</p>
      </div>
      <Counter done={tally.settled} total={run.fanout} caption="rollouts settled" />
    </div>
  );
}
