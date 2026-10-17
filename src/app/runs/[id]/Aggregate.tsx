"use client";
import type { Run } from "../../../lib/contract";
import { median, pct, tally, type Tally, type Verdict } from "../../../lib/score";
import { LiveDot, Stat } from "../../../components/ui";
import { STAGE_LABEL } from "../../../lib/sim/generate";
import type { RunClock } from "../../../lib/useRunClock";

const SPEEDS = [1, 2, 4] as const;

/**
 * What the run is doing at the instant being shown. A finished run that is mid-replay must not
 * announce "Scored 100 rollouts" two seconds in, so the label is derived from the projected tally
 * and only falls back to the backend's own wording while a live run is still warming up.
 */
function phaseLabel(t: Tally, fanout: number, run: Run): string {
  if (t.settled >= fanout) return STAGE_LABEL.done;
  if (t.settled === 0 && t.inFlight === 0) return run.stage === "done" ? STAGE_LABEL.provisioning : run.progress.label;
  return `${STAGE_LABEL.rollout} \u00b7 ${t.settled} of ${fanout} scored`;
}

/** The numbers a viewer should read first, and the controls for the replay underneath them. */
export function Aggregate({ run, verdict, clock, elapsedMs, lengthMs }: {
  run: Run;
  verdict: Verdict;
  clock: RunClock;
  elapsedMs: number;
  lengthMs: number;
}) {
  const t = tally(run.sims);
  const rewards = run.sims.filter((s) => s.status === "passed").map((s) => s.metrics.reward);
  const finished = t.settled === run.fanout;
  const progress = lengthMs > 0 ? Math.min(1, elapsedMs / lengthMs) : 0;

  return (
    <section aria-label="Run summary" className="e-tile p-5 shadow-[0_8px_24px_rgb(0_0_0/0.05)] md:p-6">
      <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Pass rate"
          hero
          tone={verdict.status === "pending" ? "ink" : verdict.status === "pass" ? "pass" : "fail"}
          value={t.settled === 0 ? "—" : pct(verdict.passRate, 0)}
          sub={t.settled === 0 ? "waiting for the first verdict" : `90% CI ${pct(verdict.lo, 0)}–${pct(verdict.hi, 0)} · n ${verdict.n}`}
        />
        <Stat label="Passed" tone="pass" value={t.passed} sub={`of ${run.fanout} rollouts`} delay={40} />
        <Stat label="Failed" tone="fail" value={t.failed} sub={t.failed > 0 ? "see the breakdown" : "none yet"} delay={80} />
        <Stat
          label="In flight"
          tone="run"
          value={t.inFlight}
          sub={<span className="inline-flex items-center gap-1.5">{t.inFlight > 0 && <LiveDot />}{t.queued} queued</span>}
          delay={120}
        />
        <Stat label="Median reward" value={rewards.length ? median(rewards).toFixed(2) : "—"} sub="passing rollouts" delay={160} />
        <Stat label="Wall clock" value={`${(elapsedMs / 1000).toFixed(1)}s`} sub={`${run.concurrency} workers · ${(lengthMs / 1000).toFixed(0)}s total`} delay={200} />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line pt-5">
        <p className="e-mono flex min-w-0 items-center gap-2.5 text-[13px] uppercase tracking-[0.04em]">
          {!finished && <LiveDot />}
          <span className="truncate">{phaseLabel(t, run.fanout, run)}</span>
        </p>
        <span className="relative h-1.5 min-w-[160px] flex-1 overflow-hidden rounded-full bg-track">
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${finished ? "bg-ink" : "e-lime"}`}
            style={{ width: `${Math.max(2, progress * 100)}%` }}
          />
        </span>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-full border border-edge">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={clock.speed === s}
                onClick={() => clock.setSpeed(s)}
                className={`e-mono cursor-pointer px-3 py-1.5 text-[12px] tabular-nums transition-colors ${clock.speed === s ? "bg-ink text-white" : "text-muted hover:bg-black/[0.04]"}`}
              >
                {s}&times;
              </button>
            ))}
          </div>
          {clock.done ? (
            <button type="button" onClick={clock.restart} className="e-pill e-ghost min-h-0 px-4 py-2">Replay</button>
          ) : (
            <>
              <button type="button" onClick={() => clock.setPlaying(!clock.playing)} className="e-pill e-ghost min-h-0 px-4 py-2">
                {clock.playing ? "Pause" : "Resume"}
              </button>
              <button type="button" onClick={clock.skipToEnd} className="e-pill e-ghost min-h-0 px-4 py-2">Skip</button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
