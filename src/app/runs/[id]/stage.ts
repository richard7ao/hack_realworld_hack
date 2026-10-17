import type { Run } from "../../../lib/contract";
import type { Tally } from "../../../lib/score";

/**
 * The four steps a viewer is walked through, and which one the run is on right now.
 *
 * Derived from the projected tally rather than the stage the backend last reported, because a
 * finished run that is being replayed must narrate the instant on screen, not its final state.
 */
export const STEPS = ["Provision", "Boot", "Rollout", "Score"] as const;

export type Step = { index: number; title: string; detail: string };

export function stepFor(t: Tally, run: Run, elapsedMs: number): Step {
  const total = run.fanout;
  if (t.settled >= total) {
    return { index: 3, title: "Run complete", detail: `${total} rollouts scored and the gate evaluated` };
  }
  if (t.settled === 0 && t.inFlight === 0) {
    return elapsedMs <= 0
      ? { index: 0, title: "Provisioning containers", detail: `Requesting ${run.concurrency} workers on Modal` }
      : { index: 1, title: "Booting simulators", detail: `Cold starting ${run.concurrency} simulator instances` };
  }
  if (t.running === 0) {
    return { index: 1, title: "Booting simulators", detail: `${t.booting} instances cold starting, ${t.queued} queued` };
  }
  return {
    index: 2,
    title: `Running ${total} rollouts`,
    detail: `${run.concurrency} workers in parallel, ${t.queued} still queued`,
  };
}
