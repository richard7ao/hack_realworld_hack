import { FAIL_MODES, type FailMode, type Gate, type Run, type Sim } from "./contract";

/** z for a two-sided 90% interval. */
const Z90 = 1.6448536269514722;

export type Tally = { passed: number; failed: number; settled: number; inFlight: number; queued: number };

export function tally(sims: readonly Sim[]): Tally {
  let passed = 0, failed = 0, inFlight = 0, queued = 0;
  for (const s of sims) {
    if (s.status === "passed") passed++;
    else if (s.status === "failed") failed++;
    else if (s.status === "running" || s.status === "booting") inFlight++;
    else queued++;
  }
  return { passed, failed, settled: passed + failed, inFlight, queued };
}

/**
 * Wilson score interval. Preferred over the normal approximation because it stays inside [0, 1] and
 * behaves at the small n you get while a run is still filling up.
 */
export function wilson(successes: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const denom = 1 + (Z90 * Z90) / n;
  const centre = (p + (Z90 * Z90) / (2 * n)) / denom;
  const margin = (Z90 * Math.sqrt((p * (1 - p)) / n + (Z90 * Z90) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

export type Check = { id: string; label: string; detail: string; ok: boolean };
export type Verdict = { status: "pass" | "fail" | "pending"; passRate: number; lo: number; hi: number; n: number; checks: Check[] };

/**
 * The CI gate.
 *
 * Two checks, both on the settled rollouts only:
 *  1. Floor      -- the LOWER bound of the 90% interval must clear the threshold, so a run cannot go
 *                   green on noise. At n=100 that costs about 6pp against the point estimate; it is
 *                   the difference between "we measured 80%" and "we know it is at least 80%".
 *  2. Regression -- the point estimate must not sit more than `regressionTolerancePp` below the
 *                   baseline run on the default branch.
 *
 * This predicate is the one real policy decision in the app. To make the bench stricter or laxer,
 * change it here and nowhere else -- the UI renders whatever checks this returns.
 */
export function evaluateGate(sims: readonly Sim[], gate: Gate): Verdict {
  const { passed, settled } = tally(sims);
  const passRate = settled > 0 ? passed / settled : 0;
  const { lo, hi } = wilson(passed, settled);
  const checks: Check[] = [
    {
      id: "floor",
      label: `Pass rate lower bound ≥ ${pct(gate.threshold)}`,
      detail: `${pct(lo)} lower bound of ${pct(passRate)} (90% CI ${pct(lo)}–${pct(hi)})`,
      ok: lo >= gate.threshold,
    },
  ];
  if (gate.baseline) {
    const floorAgainstBaseline = gate.baseline.passRate - gate.regressionTolerancePp / 100;
    const deltaPp = (passRate - gate.baseline.passRate) * 100;
    checks.push({
      id: "regression",
      label: `No regression vs ${gate.baseline.ref} (≤ ${gate.regressionTolerancePp}pp)`,
      detail: `${deltaPp >= 0 ? "+" : ""}${deltaPp.toFixed(1)}pp vs ${pct(gate.baseline.passRate)} baseline`,
      ok: passRate >= floorAgainstBaseline,
    });
  }
  const status = settled === 0 ? "pending" : checks.every((c) => c.ok) ? "pass" : "fail";
  return { status, passRate, lo, hi, n: settled, checks };
}

/** Failure modes by count, most common first, zeroes dropped. */
export function failureBreakdown(sims: readonly Sim[]): { mode: FailMode; count: number }[] {
  const counts = new Map<FailMode, number>(FAIL_MODES.map((m) => [m, 0]));
  for (const s of sims) {
    if (s.status === "failed" && s.failMode) counts.set(s.failMode, (counts.get(s.failMode) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([mode, count]) => ({ mode, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Pass rate split by how hard the domain randomisation made each rollout. This is the panel that
 * turns "87%" into something actionable: it says which conditions the policy is losing.
 */
export type Bucket = { label: string; passed: number; n: number };

export function bucketBy(sims: readonly Sim[], label: (s: Sim) => string, order: readonly string[]): Bucket[] {
  const rows = new Map<string, Bucket>(order.map((l) => [l, { label: l, passed: 0, n: 0 }]));
  for (const s of sims) {
    if (s.status !== "passed" && s.status !== "failed") continue;
    const row = rows.get(label(s));
    if (!row) continue;
    row.n++;
    if (s.status === "passed") row.passed++;
  }
  return [...rows.values()];
}

export const CLUTTER_ORDER = ["0 distractors", "1–2", "3–4", "5+"] as const;
export const clutterLabel = (s: Sim): string =>
  s.variant.distractors === 0 ? "0 distractors" : s.variant.distractors <= 2 ? "1–2" : s.variant.distractors <= 4 ? "3–4" : "5+";

export const FRICTION_ORDER = ["slippery", "nominal", "grippy"] as const;
export const frictionLabel = (s: Sim): string =>
  s.variant.friction < 0.7 ? "slippery" : s.variant.friction < 1.1 ? "nominal" : "grippy";

/** "87.0%" */
export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

/** Median of the given numbers, or 0 when empty. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Wall-clock span of the whole fan-out, in seconds: the slowest rollout's finish. */
export const wallClockS = (run: Run) => Math.max(0, ...run.sims.map((s) => s.startOffsetMs + s.durationMs)) / 1000;
