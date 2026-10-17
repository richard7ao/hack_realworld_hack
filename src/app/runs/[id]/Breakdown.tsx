"use client";
import type { FailMode, Sim } from "../../../lib/contract";
import { FAIL_LABEL } from "../../../lib/contract";
import { bucketBy, clutterLabel, CLUTTER_ORDER, failureBreakdown, frictionLabel, FRICTION_ORDER, pct, type Bucket } from "../../../lib/score";

/**
 * What the headline number is made of.
 *
 * Both panels are single-series magnitude, so they use one hue and vary only length -- a
 * categorical palette here would imply the rows are unrelated entities needing identity, when the
 * row label already carries it. Every value is directly labelled, so neither panel depends on a
 * tooltip to be readable.
 */
const MIN_N = 10;

export function Breakdown({ sims, filter, onFilter }: {
  sims: Sim[];
  filter: FailMode | null;
  onFilter: (mode: FailMode | null) => void;
}) {
  const modes = failureBreakdown(sims);
  const worst = Math.max(1, ...modes.map((m) => m.count));

  return (
    <>
      <section aria-label="Failure modes" className="e-tile p-5 shadow-[0_8px_24px_rgb(0_0_0/0.05)]">
        <div className="flex items-center justify-between gap-3">
          <h2 className="e-lbl">Why they failed</h2>
          {filter && (
            <button type="button" onClick={() => onFilter(null)} className="e-mono cursor-pointer text-[12px] text-run underline underline-offset-4">
              clear filter
            </button>
          )}
        </div>
        {modes.length === 0 ? (
          <p className="mt-4 text-[14px] text-muted">No failures yet.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2.5">
            {modes.map(({ mode, count }) => {
              const on = filter === mode;
              return (
                <li key={mode}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onFilter(on ? null : mode)}
                    className={`group w-full cursor-pointer rounded-lg px-2 py-1.5 text-left transition-colors ${on ? "bg-fail/[0.07]" : "hover:bg-black/[0.03]"}`}
                  >
                    <span className="flex items-baseline justify-between gap-3 text-[14px]">
                      <span className={on ? "font-medium" : ""}>{FAIL_LABEL[mode]}</span>
                      <span className="e-mono tabular-nums text-muted">{count}</span>
                    </span>
                    <span className="mt-1.5 block h-2 overflow-hidden rounded-[4px] bg-track">
                      <span className="block h-full rounded-[4px] bg-fail transition-[width] duration-700" style={{ width: `${(count / worst) * 100}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-[12px] leading-snug text-muted">Select a mode to isolate those rollouts in the grid.</p>
      </section>

      <section aria-label="Pass rate by condition" className="e-tile p-5 shadow-[0_8px_24px_rgb(0_0_0/0.05)]">
        <h2 className="e-lbl">Where it breaks down</h2>
        <BucketRows title="Clutter" rows={bucketBy(sims, clutterLabel, CLUTTER_ORDER)} />
        <BucketRows title="Surface friction" rows={bucketBy(sims, frictionLabel, FRICTION_ORDER)} />
        <p className="mt-4 text-[12px] leading-snug text-muted">
          Cells under n&nbsp;{MIN_N} are withheld: at that sample a rate is noise, not a finding.
        </p>
      </section>
    </>
  );
}

function BucketRows({ title, rows }: { title: string; rows: Bucket[] }) {
  return (
    <div className="mt-4">
      <h3 className="text-[12px] font-medium uppercase tracking-[0.06em] text-muted">{title}</h3>
      <ul className="mt-2.5 flex flex-col gap-2">
        {rows.map((row) => {
          const rate = row.n > 0 ? row.passed / row.n : 0;
          const thin = row.n < MIN_N;
          return (
            <li key={row.label}>
              <span className="flex items-baseline justify-between gap-3 text-[14px]">
                <span>{row.label}</span>
                <span className="e-mono tabular-nums text-muted">
                  {thin ? <span className="text-[12px]">n {row.n} · withheld</span> : <>{pct(rate, 0)} <span className="text-[12px]">n {row.n}</span></>}
                </span>
              </span>
              <span className="mt-1.5 block h-2 overflow-hidden rounded-[4px] bg-track">
                {!thin && <span className="block h-full rounded-[4px] bg-pass transition-[width] duration-700" style={{ width: `${rate * 100}%` }} />}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
