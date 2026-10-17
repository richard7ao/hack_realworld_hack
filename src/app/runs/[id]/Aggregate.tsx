"use client";
import type { Run, Sim } from "../../../lib/contract";
import { median, pct, type Tally, type Verdict } from "../../../lib/score";
import { LiveDot, Stat } from "../../../components/ui";
import type { RunClock } from "../../../lib/useRunClock";

const SPEEDS = [1, 2, 4] as const;

/** The figures, then the transport controls for the replay. */
export function Aggregate({ run, sims, tally: t, verdict, clock, elapsedMs, lengthMs }: {
  run: Run;
  /** Projected onto the replay clock. Never read run.sims here: it knows the future. */
  sims: Sim[];
  tally: Tally;
  verdict: Verdict;
  clock: RunClock;
  elapsedMs: number;
  lengthMs: number;
}) {
  const rewards = sims.filter((s) => s.status === "passed").map((s) => s.metrics.reward);
  const pending = verdict.status === "pending";

  return (
    <section aria-label="Run metrics" className="card p-5">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Pass rate"
          tone={pending ? "ink" : verdict.status === "pass" ? "pass" : "fail"}
          value={t.settled === 0 ? "–" : pct(verdict.passRate, 0)}
          sub={t.settled === 0 ? "no verdicts yet" : `90% CI ${pct(verdict.lo, 0)}–${pct(verdict.hi, 0)} · n ${verdict.n}`}
        />
        <Stat label="Passed" tone="pass" value={t.passed} sub={`of ${run.fanout} rollouts`} delay={40} />
        <Stat label="Failed" tone="fail" value={t.failed} sub={t.failed > 0 ? "see the breakdown" : "none yet"} delay={80} />
        <Stat
          label="In flight"
          tone="brand"
          value={t.inFlight}
          sub={<span className="inline-flex items-center gap-1.5">{t.inFlight > 0 && <LiveDot />}{t.queued} queued</span>}
          delay={120}
        />
        <Stat label="Median reward" value={rewards.length ? median(rewards).toFixed(2) : "–"} sub="passing rollouts" delay={160} />
        <Stat label="Wall clock" value={`${(elapsedMs / 1000).toFixed(1)}s`} sub={`${(lengthMs / 1000).toFixed(0)}s end to end`} delay={200} />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line-soft pt-4">
        <span className="mr-auto text-[12.5px] text-muted">
          Replaying the recorded episodes. The simulation already ran.
        </span>
        <div className="flex overflow-hidden rounded-full border border-line p-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={clock.speed === s}
              onClick={() => clock.setSpeed(s)}
              className={`mono cursor-pointer rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${clock.speed === s ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
            >
              {s}&times;
            </button>
          ))}
        </div>
        {clock.done ? (
          <button type="button" onClick={clock.restart} className="pill pill-ghost h-9 px-4 text-[13px]">Replay</button>
        ) : (
          <>
            <button type="button" onClick={() => clock.setPlaying(!clock.playing)} className="pill pill-ghost h-9 px-4 text-[13px]">
              {clock.playing ? "Pause" : "Resume"}
            </button>
            <button type="button" onClick={clock.skipToEnd} className="pill pill-ghost h-9 px-4 text-[13px]">Skip to end</button>
          </>
        )}
      </div>
    </section>
  );
}
