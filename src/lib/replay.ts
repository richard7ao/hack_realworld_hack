import type { Sim } from "./contract";
import { phaseAt } from "./sim/arm";

/**
 * What a cell should show right now.
 *
 * The run clock is the client's, not the server's: a complete run (fixture mode, or a run opened
 * after it finished) is replayed from t=0 against each rollout's own window, so the grid animates
 * identically whether the data came from disk or from Modal. The backend's `status` is consulted
 * only once the clock says the episode is over, because that is the first moment a verdict is
 * meaningful -- and a rollout the backend still calls "running" past its estimate is an overrun,
 * not a pass.
 */
export type CellState = "queued" | "booting" | "running" | "passed" | "failed";

export function cellStateAt(sim: Sim, elapsedMs: number): CellState {
  const phase = phaseAt(sim, elapsedMs);
  if (phase !== "settled") return phase;
  return sim.status === "passed" || sim.status === "failed" ? sim.status : "running";
}

export const isSettled = (state: CellState): state is "passed" | "failed" => state === "passed" || state === "failed";

/** When this rollout's verdict lands, in ms since run start. Drives the settle flash. */
export const settlesAt = (sim: Sim) => sim.startOffsetMs + sim.durationMs;

/** The whole fan-out's wall clock, in ms. */
export const runLengthMs = (sims: readonly Sim[]) => Math.max(0, ...sims.map(settlesAt));

/** The rollouts as the clock currently sees them, for any tally or gate computed during replay. */
export function simsAt(sims: readonly Sim[], elapsedMs: number): Sim[] {
  return sims.map((s) => {
    const state = cellStateAt(s, elapsedMs);
    if (state === s.status) return s;
    const revealed = s.failAt !== null && elapsedMs >= s.startOffsetMs + s.failAt * s.durationMs;
    return { ...s, status: state, failMode: revealed ? s.failMode : null, failAt: revealed ? s.failAt : null };
  });
}
