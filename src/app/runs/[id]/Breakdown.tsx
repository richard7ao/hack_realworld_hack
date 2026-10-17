"use client";
import type { FailMode, Sim } from "../../../lib/contract";
import { FAIL_LABEL } from "../../../lib/contract";
import { bucketBy, clutterLabel, CLUTTER_ORDER, failureBreakdown, frictionLabel, FRICTION_ORDER, pct, type Bucket } from "../../../lib/score";

/**
 * What the headline number is made of.
 *
 * Both panels are single-series magnitude, so they use one hue and vary only length. A
 * categorical palette here would imply the rows are unrelated entities needing identity, when the
 * row label already carries it. Every value is directly labelled, so neither panel needs a
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
      <section aria-label="Failure modes" className="card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="label">Why they failed</h2>
          {filter && (
            <button type="button" onClick={() => onFilter(null)} className="text-[12px] font-semibold text-brand underline-offset-4 hover:underline">
              Clear filter
            </button>
          )}
        </div>
        {modes.length === 0 ? (
          <p className="mt-4 text-[14px] text-muted">No failures yet.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {modes.map(({ mode, count }) => {
              const on = filter === mode;
              return (
                <li key={mode}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onFilter(on ? null : mode)}
                    className={`w-full cursor-pointer rounded-lg px-2.5 py-2 text-left transition-colors ${on ? "bg-fail-soft" : "hover:bg-[#F7F8FA]"}`}
                  >
                    <span className="flex items-baseline justify-between gap-3 text-[13.5px]">
                      <span className={on ? "font-semibold text-ink" : "text-ink-2"}>{FAIL_LABEL[mode]}</span>
                      <span className="mono text-muted">{count}</span>
                    </span>
                    <span className="mt-1.5 block h-[7px] overflow-hidden rounded-[4px] bg-track">
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

      <section aria-label="Pass rate by condition" className="card p-5">
        <h2 className="label">Where it breaks down</h2>
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
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">{title}</h3>
      <ul className="mt-2.5 flex flex-col gap-2.5">
        {rows.map((row) => {
          const rate = row.n > 0 ? row.passed / row.n : 0;
          const thin = row.n < MIN_N;
          return (
            <li key={row.label}>
              <span className="flex items-baseline justify-between gap-3 text-[13.5px]">
                <span className="text-ink-2">{row.label}</span>
                <span className="mono text-muted">
                  {thin ? <span className="text-[11.5px]">n {row.n}, withheld</span> : <>{pct(rate, 0)} <span className="text-[11.5px] text-faint">n {row.n}</span></>}
                </span>
              </span>
              <span className="mt-1.5 block h-[7px] overflow-hidden rounded-[4px] bg-track">
                {!thin && <span className="block h-full rounded-[4px] bg-pass transition-[width] duration-700" style={{ width: `${rate * 100}%` }} />}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
