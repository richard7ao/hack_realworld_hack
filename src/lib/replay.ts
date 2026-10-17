import type { BenchmarkCase, Outcome } from "./contract";

/**
 * What a CI Bench tile shows at a given instant of the run clock.
 *
 * PRD tile states are pending, running and the five outcomes. A finished run is replayed from
 * t=0 against each case's own window, so the grid animates the same way whether the data came from
 * a fixture or a live backend. A result is only shown once the clock reaches the case's finish,
 * because before that the UI has no business knowing it.
 */
export type CellState = "pending" | "running" | Outcome;

export function cellStateAt(c: BenchmarkCase, elapsedMs: number): CellState {
  if (c.started_at_ms === null || elapsedMs < c.started_at_ms) return "pending";
  if (c.finished_at_ms === null || elapsedMs < c.finished_at_ms || !c.result) return "running";
  return c.result.outcome;
}

/** The whole run's wall clock in ms: the latest finish, or the latest start while still running. */
export function runLengthMs(cases: readonly BenchmarkCase[]): number {
  return Math.max(0, ...cases.map((c) => c.finished_at_ms ?? c.started_at_ms ?? 0));
}

/**
 * The cases as the clock currently sees them. Any figure computed during a replay must come from
 * this projection, never from the raw run, which already knows how every case ends.
 */
export function casesAt(cases: readonly BenchmarkCase[], elapsedMs: number): BenchmarkCase[] {
  return cases.map((c) => {
    const state = cellStateAt(c, elapsedMs);
    if (state === "pending") return c.status === "pending" && c.result === null ? c : { ...c, status: "pending", result: null };
    if (state === "running") return c.status === "running" && c.result === null ? c : { ...c, status: "running", result: null };
    return c;
  });
}
