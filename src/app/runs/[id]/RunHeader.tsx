"use client";
import type { Run } from "../../../lib/contract";
import { pct, type Check, type Tally, type Verdict } from "../../../lib/score";
import { Counter, Glyph } from "../../../components/ui";
import { STEPS, stepFor } from "./stage";

/**
 * Step eyebrow, page title, and the counter that carries the run's progress on its own.
 *
 * Once the gate has decided, the title stops describing the process and states the outcome. The
 * decision is the whole reason the run exists, so it belongs at the top of the page, not under a
 * thousand pixels of grid.
 */
export function RunHeader({ run, tally, verdict, elapsedMs }: { run: Run; tally: Tally; verdict: Verdict; elapsedMs: number }) {
  const step = stepFor(tally, run, elapsedMs);
  const complete = tally.settled >= run.fanout;
  const decided = verdict.status !== "pending";
  const failing = verdict.checks.find((c) => c.ok === false);

  const title = complete && decided ? (verdict.status === "pass" ? "Ready to merge" : "Merge blocked") : step.title;
  const detail = complete && decided
    ? verdict.status === "pass"
      ? `${pct(verdict.passRate)} pass rate${run.gate.baseline ? `, ${verdict.checks.find((c) => c.id === "regression")?.detail ?? ""}` : ""}`
      : missed(failing, verdict, run)
    : step.detail;

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        <p className="eyebrow">Step {step.index + 1} of {STEPS.length} · {STEPS[step.index]}</p>
        <h1 key={title} className={`h2 a-blur-in mt-2.5 text-[34px] md:text-[44px] ${complete && decided ? (verdict.status === "pass" ? "text-pass" : "text-fail") : ""}`}>
          {title}
        </h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px] text-muted">
          {decided && (
            <span className={`a-badge inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold ${verdict.status === "pass" ? "bg-pass-soft text-pass" : "bg-fail-soft text-fail"}`}>
              <Glyph state={verdict.status === "pass" ? "pass" : "fail"} />
              {verdict.status === "pass" ? "Gate passed" : complete ? "Gate failed" : "Gate failed early"}
            </span>
          )}
          <span>{detail}</span>
        </p>
      </div>
      <Counter done={tally.settled} total={run.fanout} caption="rollouts settled" />
    </div>
  );
}

/** Why a blocked run was blocked: the shortfall, not the rule restated. */
function missed(check: Check | undefined, verdict: Verdict, run: Run): string {
  if (!check) return "A gate check failed";
  if (check.id === "floor") return `Lower bound ${pct(verdict.lo)} misses the ${pct(run.gate.threshold)} floor`;
  if (check.id === "regression") return `Regressed ${check.detail}`;
  return check.label;
}
