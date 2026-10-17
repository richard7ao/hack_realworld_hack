"use client";
import type { Run } from "../../../lib/contract";
import { pct, type Verdict as GateVerdict } from "../../../lib/score";
import { Meter } from "../../../components/ui";

/**
 * The CI gate. This is the screen's point: a hundred rollouts exist to produce one merge decision,
 * and the decision has to show its working, so every check prints the number it judged.
 *
 * Status is never colour alone -- each row carries a glyph and a word as well.
 */
export function Verdict({ run, verdict }: { run: Run; verdict: GateVerdict }) {
  const { status } = verdict;
  const tone = status === "pass"
    ? { ring: "border-pass/50 bg-pass/[0.06]", ink: "text-pass-ink", glyph: "✓", word: "Gate passed" }
    : status === "fail"
      ? { ring: "border-fail/50 bg-fail/[0.05]", ink: "text-fail", glyph: "✕", word: "Gate failed" }
      : { ring: "border-edge", ink: "text-muted", glyph: "·", word: "Awaiting results" };

  return (
    <section aria-label="Merge gate" className={`e-tile border p-5 shadow-[0_8px_24px_rgb(0_0_0/0.05)] md:p-6 ${tone.ring} ${status === "pass" ? "fk-glow" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="e-lbl">Merge gate</span>
          <p className={`e-h mt-2 flex items-center gap-3 text-[30px] md:text-[38px] ${tone.ink}`}>
            <span aria-hidden className={`fk-badge grid size-9 flex-none place-items-center rounded-full text-[18px] ${status === "pass" ? "bg-pass text-white" : status === "fail" ? "bg-fail text-white" : "bg-track text-muted"}`}>
              {tone.glyph}
            </span>
            {tone.word}
          </p>
        </div>
        <dl className="e-mono grid gap-1 text-[12px] leading-relaxed text-muted">
          <div className="flex gap-2"><dt className="w-[62px]">policy</dt><dd className="text-ink">{run.policy.name}</dd></div>
          <div className="flex gap-2"><dt className="w-[62px]">commit</dt><dd className="text-ink">{run.policy.branch}@{run.policy.commit}</dd></div>
          <div className="flex gap-2"><dt className="w-[62px]">baseline</dt><dd className="text-ink">{run.gate.baseline?.ref ?? "none"}</dd></div>
        </dl>
      </div>

      <ul className="mt-5 flex flex-col gap-3 border-t border-line pt-5">
        {verdict.checks.map((check) => (
          <li key={check.id} className="flex items-start gap-3">
            <span
              aria-hidden
              className={`mt-0.5 grid size-5 flex-none place-items-center rounded-full text-[11px] font-bold text-white ${check.ok ? "bg-pass" : "bg-fail"}`}
            >
              {check.ok ? "✓" : "✕"}
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] leading-snug">
                {check.label} <span className="sr-only">{check.ok ? "passed" : "failed"}</span>
              </span>
              <span className="e-mono mt-0.5 block text-[12px] text-muted">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {run.gate.baseline && (
        <div className="mt-5 border-t border-line pt-5">
          <div className="flex items-baseline justify-between text-[13px]">
            <span className="text-muted">This run</span>
            <span className="e-mono tabular-nums">{pct(verdict.passRate)}</span>
          </div>
          <div className="mt-1.5"><Meter value={verdict.passRate} tone={status === "fail" ? "fail" : "pass"} /></div>
          <div className="mt-3 flex items-baseline justify-between text-[13px]">
            <span className="text-muted">{run.gate.baseline.ref}</span>
            <span className="e-mono tabular-nums">{pct(run.gate.baseline.passRate)}</span>
          </div>
          <div className="mt-1.5"><Meter value={run.gate.baseline.passRate} tone="ink" /></div>
        </div>
      )}
    </section>
  );
}
