"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { FailMode, Run } from "../../../lib/contract";
import { errorText } from "../../../lib/client";
import { cellStateAt, runLengthMs, simsAt } from "../../../lib/replay";
import { evaluateGate } from "../../../lib/score";
import { useEndpoint } from "../../../lib/useEndpoint";
import { useRunClock } from "../../../lib/useRunClock";
import { Logo } from "../../../components/Logo";
import { ErrorNote, WRAP } from "../../../components/ui";
import { Aggregate } from "./Aggregate";
import { Breakdown } from "./Breakdown";
import { SimDrawer } from "./SimDrawer";
import { SimGrid } from "./SimGrid";
import { Verdict } from "./Verdict";

/**
 * The bench.
 *
 * One clock drives everything. The run that arrives over the wire is the script; `simsAt` projects
 * it onto the current instant, and every panel is derived from that projection rather than from the
 * raw response. That is what keeps the headline number, the gate and the grid from ever disagreeing
 * with each other by a frame.
 */
export function Bench({ runId }: { runId: string }) {
  const { data: run, error } = useEndpoint("run", {
    params: { id: runId },
    pollMs: 1000,
    until: (r) => r.stage === "done",
  });

  if (error) {
    return (
      <Shell>
        <div className="py-20">
          <ErrorNote>Could not load this run. {errorText(error)}</ErrorNote>
          <Link href="/" className="e-pill e-outline mt-5 px-5">Start a new run</Link>
        </div>
      </Shell>
    );
  }
  if (!run) return <Shell><Loading /></Shell>;
  return <Loaded run={run} />;
}

function Loaded({ run }: { run: Run }) {
  const lengthMs = useMemo(() => runLengthMs(run.sims), [run.sims]);
  const clock = useRunClock(lengthMs);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FailMode | null>(null);

  // Projected onto the replay clock, so nothing claims an outcome the clock has not reached.
  const sims = useMemo(() => simsAt(run.sims, clock.elapsed), [run.sims, clock.elapsed]);
  const verdict = useMemo(() => evaluateGate(sims, run.gate), [sims, run.gate]);

  const dimmed = useMemo(
    () => (filter === null ? null : new Set(sims.filter((s) => s.failMode === filter).map((s) => s.id))),
    [filter, sims],
  );

  const open = openId ? run.sims.find((s) => s.id === openId) : undefined;

  return (
    <Shell run={run}>
      <div className="flex flex-col gap-4 pb-16">
        <Aggregate run={{ ...run, sims }} verdict={verdict} clock={clock} elapsedMs={Math.min(clock.elapsed, lengthMs)} lengthMs={lengthMs} />

        <p className="sr-only" aria-live="polite">
          {verdict.n} of {run.fanout} rollouts settled. Pass rate {(verdict.passRate * 100).toFixed(0)} percent.
        </p>

        <section aria-label="Simulations" className="e-tile p-4 shadow-[0_8px_24px_rgb(0_0_0/0.05)] md:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="e-lbl">{run.fanout} simulations</h2>
            <p className="text-[13px] text-muted">
              {filter ? "Filtered. Select the mode again to clear." : "Select any cell for its conditions and trace."}
            </p>
          </div>
          <SimGrid sims={run.sims} clockRef={clock.ref} onOpen={setOpenId} dimmed={dimmed} />
        </section>

        <div className="grid gap-4 lg:grid-cols-3">
          <Verdict run={run} verdict={verdict} />
          <Breakdown sims={sims} filter={filter} onFilter={setFilter} />
        </div>
      </div>

      {open && <SimDrawer sim={open} state={cellStateAt(open, clock.elapsed)} onClose={() => setOpenId(null)} />}
    </Shell>
  );
}

function Shell({ run, children }: { run?: Run; children: React.ReactNode }) {
  return (
    <div className="theme-e min-h-screen">
      <header className="border-b border-line">
        <div className={`${WRAP} flex flex-wrap items-center justify-between gap-3 py-[18px]`}>
          <Logo />
          {run && (
            <p className="order-last w-full min-w-0 text-[14px] leading-snug text-muted md:order-none md:w-auto md:flex-1 md:px-8 md:text-center">
              <span className="text-ink">{run.environmentName}</span>
              <span className="mx-2 text-muted/50">/</span>
              {run.task}
            </p>
          )}
          <Link href="/" className="e-pill e-outline px-4">New run</Link>
        </div>
      </header>
      <main className={`${WRAP} pt-5`}>{children}</main>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-4 py-5">
      <div className="fk-shimmer h-[180px] rounded-2xl" />
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 md:grid-cols-8 xl:grid-cols-10">
        {Array.from({ length: 40 }, (_, i) => (
          <span key={i} className="fk-shimmer aspect-[5/4] rounded-[10px]" style={{ animationDelay: `${(i % 10) * 90}ms` }} />
        ))}
      </div>
    </div>
  );
}
