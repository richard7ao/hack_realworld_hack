"use client";
import type { Run, Sim } from "../../../lib/contract";
import type { Tally } from "../../../lib/score";
import { SimCanvas } from "../../../components/SimCanvas";
import { environmentById } from "../../../lib/sim/environments";
import { AgentLog } from "./AgentLog";

/**
 * The run's standing context, pinned beside the grid. It answers "what am I looking at" without
 * the viewer having to scroll back up, which matters once the grid is a thousand pixels tall.
 */
export function Sidebar({ run, tally, hero }: { run: Run; tally: Tally; hero: Sim | undefined }) {
  const env = environmentById(run.environmentId);
  return (
    <div className="flex flex-col gap-3 lg:sticky lg:top-5">
      <section aria-label="Run context" className="card overflow-hidden">
        <div className="flex items-center gap-2.5 border-b border-line-soft bg-[#FAFBFC] px-3.5 py-2.5">
          <span aria-hidden className="flex gap-1.5">
            {[0, 1, 2].map((i) => <span key={i} className="size-2.5 rounded-full bg-[#DFE3EA]" />)}
          </span>
          <span className="mono mx-auto truncate rounded-full bg-surface px-3 py-0.5 text-[11px] text-muted ring-1 ring-line">
            {run.environmentId}
          </span>
          <span aria-hidden className="w-[38px]" />
        </div>

        {hero && <SimCanvas sim={hero} loop ring={false} className="block aspect-[5/4] w-full bg-surface" />}
        <p className="border-t border-line-soft px-4 py-2 text-[11px] text-faint">Task preview, nominal conditions</p>

        <div className="border-t border-line-soft p-4">
          <h2 className="text-[16px] font-bold tracking-[-0.02em]">{run.environmentName}</h2>
          <p className="mt-1.5 text-[13px] leading-snug text-muted">{env?.blurb}</p>

          <p className="mt-3.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">Task</p>
          <p className="mt-1 text-[14px] leading-snug text-ink-2">{run.task}</p>

          <dl className="mono mt-4 flex flex-col gap-1.5 border-t border-line-soft pt-3.5 text-[11.5px]">
            {[
              ["policy", run.policy.name],
              ["branch", run.policy.branch],
              ["commit", run.policy.commit],
              ["fan-out", `${run.fanout} × ${run.concurrency} workers`],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <dt className="text-faint">{k}</dt>
                <dd className="truncate text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <AgentLog run={run} tally={tally} />
    </div>
  );
}
