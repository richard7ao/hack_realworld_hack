"use client";
import type { Run } from "../../../lib/contract";
import { pct, type Verdict as GateVerdict } from "../../../lib/score";
import { Glyph, Meter } from "../../../components/ui";

/**
 * The merge gate. A hundred rollouts exist to produce one decision, so the decision shows its
 * working: every check prints the number it judged. Status is never colour alone, each row
 * carries a glyph and a word.
 */
export function Verdict({ run, verdict }: { run: Run; verdict: GateVerdict }) {
  const { status } = verdict;
  const tone = {
    pass: { wrap: "ring-2 ring-pass/30 bg-pass-soft/40", ink: "text-pass", word: "Gate passed", glyph: "pass" as const },
    fail: { wrap: "ring-2 ring-fail/30 bg-fail-soft/40", ink: "text-fail", word: "Gate failed", glyph: "fail" as const },
    pending: { wrap: "ring-1 ring-line", ink: "text-muted", word: "Not yet decided", glyph: "idle" as const },
  }[status];

  return (
    <section aria-label="Merge gate" className={`card p-5 ${tone.wrap}`}>
      <h2 className="label">Merge gate</h2>
      <p className={`h2 mt-2.5 flex items-center gap-2.5 text-[26px] ${tone.ink}`}>
        <span className="a-badge inline-flex"><Glyph state={tone.glyph} /></span>
        {tone.word}
      </p>
      <p className="mt-1.5 text-[13px] leading-snug text-muted">
        {status === "pending"
          ? "The run has not produced enough evidence to decide."
          : `Judged on ${verdict.n} settled rollouts.`}
      </p>

      <ul className="mt-4 flex flex-col gap-3 border-t border-line-soft pt-4">
        {verdict.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-2.5">
            <span className="mt-0.5"><Glyph state={check.ok === null ? "idle" : check.ok ? "pass" : "fail"} /></span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium leading-snug text-ink-2">
                {check.label}
                <span className="sr-only">{check.ok === null ? " not yet decided" : check.ok ? " passed" : " failed"}</span>
              </span>
              <span className="mono mt-0.5 block text-[11.5px] text-muted">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {run.gate.baseline && (
        <div className="mt-4 border-t border-line-soft pt-4">
          <div className="flex items-baseline justify-between text-[12.5px]">
            <span className="text-muted">This run</span>
            <span className="mono text-ink">{verdict.n > 0 ? pct(verdict.passRate) : "–"}</span>
          </div>
          <div className="mt-1.5"><Meter value={verdict.passRate} tone={status === "fail" ? "fail" : status === "pass" ? "pass" : "brand"} /></div>
          <div className="mt-3 flex items-baseline justify-between text-[12.5px]">
            <span className="mono text-muted">{run.gate.baseline.ref}</span>
            <span className="mono text-ink">{pct(run.gate.baseline.passRate)}</span>
          </div>
          <div className="mt-1.5"><Meter value={run.gate.baseline.passRate} tone="ink" /></div>
        </div>
      )}
    </section>
  );
}
