"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { FailMode, Run } from "../../../lib/contract";
import { errorText } from "../../../lib/client";
import { cellStateAt, runLengthMs, simsAt } from "../../../lib/replay";
import { evaluateGate, tally } from "../../../lib/score";
import { useEndpoint } from "../../../lib/useEndpoint";
import { useRunClock } from "../../../lib/useRunClock";
import { Logo } from "../../../components/Logo";
import { ErrorNote, WRAP } from "../../../components/ui";
import { Aggregate } from "./Aggregate";
import { Breakdown } from "./Breakdown";
import { RunHeader } from "./RunHeader";
import { Sidebar } from "./Sidebar";
import { SimDrawer } from "./SimDrawer";
import { SimGrid } from "./SimGrid";
import { Verdict } from "./Verdict";

/**
 * The bench.
 *
 * One clock drives everything. The run that arrives over the wire is the script; `simsAt` projects
 * it onto the current instant, and every panel derives from that projection rather than from the
 * raw response. That is what stops the headline number, the gate and the grid disagreeing by a
 * frame. The grid is the one exception: it reads the clock ref directly inside its own frame loop,
 * because re-rendering a hundred cells at sixty hertz is not affordable.
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
          <Link href="/" className="pill pill-dark mt-5">Start a new run</Link>
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

  const sims = useMemo(() => simsAt(run.sims, clock.elapsed), [run.sims, clock.elapsed]);
  const t = useMemo(() => tally(sims), [sims]);
  const verdict = useMemo(() => evaluateGate(sims, run.gate), [sims, run.gate]);

  // Keyed on membership, not on `sims`: the projection is a new array every tick, and a new Set
  // every tick would defeat the grid's memo for no change on screen.
  const matchKey = filter === null ? null : sims.filter((s) => s.failMode === filter).map((s) => s.id).join(",");
  const dimmed = useMemo(() => (matchKey === null ? null : new Set(matchKey ? matchKey.split(",") : [])), [matchKey]);

  // From the projection, not run.sims: the raw script knows how every episode ends.
  const open = openId ? sims.find((s) => s.id === openId) : undefined;
  // An illustration of the task: the first rollout's conditions on the nominal, successful script.
  // Picking "a rollout that passed" from the raw run would leak an outcome the clock has not shown.
  const hero = useMemo(
    () => (run.sims[0] ? { ...run.sims[0], status: "passed" as const, failMode: null, failAt: null } : undefined),
    [run.sims],
  );
  const shown = Math.min(clock.elapsed, lengthMs);

  return (
    <Shell run={run} progress={lengthMs > 0 ? shown / lengthMs : 0} running={!clock.done}>
      <div className="grid gap-4 pb-16 lg:grid-cols-[316px_minmax(0,1fr)]">
        {/* After the main column on phones, so the outcome and counter are the first thing seen. */}
        <aside className="order-last lg:order-none lg:row-span-2">
          <Sidebar run={run} tally={t} hero={hero} />
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <RunHeader run={run} tally={t} verdict={verdict} elapsedMs={shown} />

          <p className="sr-only" aria-live="polite">
            {t.settled} of {run.fanout} rollouts settled.
          </p>

          <Aggregate run={run} sims={sims} tally={t} verdict={verdict} clock={clock} elapsedMs={shown} lengthMs={lengthMs} />

          <section aria-label="Simulations" className="card p-4 md:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="label">{run.fanout} simulations</h2>
              <p className="text-[12.5px] text-muted">
                {filter ? "Filtered. Select the mode again to clear." : "Select any cell for its conditions and trace."}
              </p>
            </div>
            <SimGrid sims={run.sims} clockRef={clock.ref} onOpen={setOpenId} dimmed={dimmed} />
          </section>

          <div className="grid gap-4 xl:grid-cols-3">
            <Verdict run={run} verdict={verdict} />
            <Breakdown sims={sims} filter={filter} onFilter={setFilter} />
          </div>
        </div>
      </div>

      {open && <SimDrawer sim={open} state={cellStateAt(open, clock.elapsed)} clockRef={clock.ref} onClose={() => setOpenId(null)} />}
    </Shell>
  );
}

function Shell({ run, children, progress = 0, running = false }: {
  run?: Run;
  children: React.ReactNode;
  progress?: number;
  running?: boolean;
}) {
  return (
    <div className="field min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-surface/85 backdrop-blur-md">
        <div className={`${WRAP} flex h-[62px] items-center justify-between gap-3`}>
          <Logo />
          {run && (
            <p className="hidden min-w-0 flex-1 truncate px-8 text-center text-[14px] text-muted md:block">
              <span className="font-semibold text-ink">{run.environmentName}</span>
              <span className="mx-2 text-[#CDD2DA]">/</span>
              {run.task}
            </p>
          )}
          <Link href="/" className="pill pill-dark">New run</Link>
        </div>
        {/* The run's progress, as a hairline under the nav. */}
        <div className="relative h-[2px] w-full overflow-hidden bg-line-soft">
          <span className="absolute inset-y-0 left-0 bg-brand transition-[width] duration-200 ease-linear" style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
          {running && <span aria-hidden className="a-sweep absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-brand/45 to-transparent" />}
        </div>
      </header>
      <main className={`${WRAP} pt-5`}>{children}</main>
    </div>
  );
}

function Loading() {
  return (
    <div className="grid gap-4 py-5 lg:grid-cols-[316px_minmax(0,1fr)]">
      <div className="a-shimmer h-[520px] rounded-[14px]" />
      <div className="flex flex-col gap-4">
        <div className="a-shimmer h-[112px] rounded-[14px]" />
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5 md:grid-cols-7 xl:grid-cols-10">
          {Array.from({ length: 40 }, (_, i) => (
            <span key={i} className="a-shimmer aspect-[5/4] rounded-[10px]" style={{ animationDelay: `${(i % 10) * 90}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
