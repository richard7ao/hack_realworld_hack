import { FAIL_MODES, type FailMode, type Run, type RunStage, type Sim, type Variant } from "../contract";
import { between, hashSeed, intBetween, mulberry32, pickWeighted } from "../rng";
import { environmentById, ENVIRONMENTS } from "./environments";

/**
 * The hardcoded fallback: a complete, plausible 100-rollout eval, derived entirely from one seed.
 *
 * It exists so the whole product is demonstrable before the Modal backend lands, and so the UI has
 * something deterministic to be tested against afterwards. The failure distribution is causal, not
 * random: a rollout that drew heavy clutter is the one that collides, and a slippery one is the one
 * that drops the object. That is what makes the breakdown panels say something true about the
 * policy rather than just reflecting the RNG.
 */
export type GenerateOpts = {
  id: string;
  environmentId: string;
  task: string;
  fanout: number;
  /** Share of rollouts expected to succeed, before difficulty weighting. */
  skill?: number;
  policy?: { name: string; commit: string; branch: string };
  baseline?: { ref: string; passRate: number; n: number } | null;
  /** Report the run as if it were this many ms in, leaving later rollouts unsettled. */
  freezeAtMs?: number;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** How hard this particular randomisation made the rollout, in 0..1. */
export function difficultyOf(v: Variant): number {
  const clutter = v.distractors / 6;
  const slip = clamp01(1 - (v.friction - 0.3) / 0.9);
  const offset = (Math.abs(v.objectDx) + Math.abs(v.objectDy)) / 2;
  const light = Math.min(1, Math.abs(v.lighting - 0.55) * 2);
  return clamp01(0.30 * clutter + 0.26 * slip + 0.22 * offset + 0.12 * light + 0.10 * v.cameraJitter);
}

/** Which way a rollout breaks, given what the randomiser threw at it. */
export function failModeFor(rnd: () => number, v: Variant): FailMode {
  const clutter = v.distractors / 6;
  const slip = clamp01(1 - (v.friction - 0.3) / 0.9);
  const offset = (Math.abs(v.objectDx) + Math.abs(v.objectDy)) / 2;
  const light = Math.min(1, Math.abs(v.lighting - 0.55) * 2);
  return pickWeighted<FailMode>(rnd, [
    ["collision", 0.4 + 2.6 * clutter],
    ["grasp_slip", 0.4 + 2.6 * slip],
    ["missed_approach", 0.3 + 2.4 * offset + 1.4 * v.cameraJitter],
    ["dropped_outside", 0.5 + 0.8 * slip],
    ["timeout", 0.3 + 1.2 * light],
  ]);
}

/** Where in the episode each mode shows itself. A collision happens on approach, a drop near the bin. */
const FAIL_WINDOW: Record<FailMode, [number, number]> = {
  collision: [0.16, 0.34],
  missed_approach: [0.30, 0.40],
  grasp_slip: [0.42, 0.66],
  dropped_outside: [0.74, 0.86],
  timeout: [0.30, 0.60],
};

function variantFor(rnd: () => number, bias: number): Variant {
  return {
    lighting: between(rnd, 0.2, 0.95),
    friction: between(rnd, 0.35, 1.35),
    objectDx: between(rnd, -1, 1) * (0.5 + bias * 0.5),
    objectDy: between(rnd, -1, 1) * 0.4,
    distractors: intBetween(rnd, 0, Math.round(2 + bias * 4)),
    cameraJitter: between(rnd, 0, 0.9),
  };
}

export function generateRun(opts: GenerateOpts): Run {
  const {
    id, environmentId, task, fanout,
    skill = 0.87,
    policy = { name: "pi0-fast", commit: "a3f91c2", branch: "feat/grasp-refine" },
    baseline = { ref: "main@7d21e0b", passRate: 0.82, n: 100 },
    freezeAtMs,
  } = opts;

  const env = environmentById(environmentId) ?? ENVIRONMENTS[0]!;
  const hardness = env.difficulty === "hard" ? 1 : env.difficulty === "medium" ? 0.6 : 0.3;
  const rnd = mulberry32(hashSeed(id));
  const targetFail = 1 - skill;

  // Two passes: draw every variant first so failure probability can be normalised against the mean
  // difficulty of this particular fan-out, which keeps the headline rate near `skill` whatever the
  // environment throws.
  const drafts = Array.from({ length: fanout }, (_, i) => {
    const variant = variantFor(rnd, hardness);
    return { i, variant, difficulty: difficultyOf(variant), seed: (hashSeed(`${id}:${i}`) >>> 1) };
  });
  // Difficulty is a sum of five roughly uniform terms, so it clusters tightly around its mean and
  // the raw value barely separates one rollout from another. Rescaling across this fan-out's own
  // spread is what actually makes a hard rollout likelier to fail, and so what makes the breakdown
  // panels report something about the policy rather than about the RNG.
  const spread = drafts.map((d) => d.difficulty);
  const lowest = Math.min(...spread);
  const range = Math.max(1e-6, Math.max(...spread) - lowest);
  const weight = (d: number) => 0.25 + 1.75 * ((d - lowest) / range);
  const meanWeight = spread.reduce((s, d) => s + weight(d), 0) / Math.max(1, spread.length);

  const sims: Sim[] = drafts.map(({ i, variant, difficulty, seed }) => {
    const pFail = Math.min(0.95, (targetFail * weight(difficulty)) / meanWeight);
    const fails = rnd() < pFail;
    const failMode = fails ? failModeFor(rnd, variant) : null;
    const [lo, hi] = failMode ? FAIL_WINDOW[failMode] : [0, 0];
    const failAt = failMode ? between(rnd, lo, hi) : null;

    // Modal cold starts: most containers are warm, a tail is not.
    const startOffsetMs = Math.round(between(rnd, 80, 1700) + (rnd() < 0.14 ? between(rnd, 700, 2400) : 0));
    const durationMs = failMode === "timeout"
      ? 12000
      : Math.round(between(rnd, 5200, 7200) + difficulty * 2600);

    const reward = failMode
      ? Number((0.04 + (failAt ?? 0) * 0.42 + between(rnd, -0.03, 0.03)).toFixed(3))
      : Number(between(rnd, 0.72, 0.98).toFixed(3));

    return {
      id: `sim-${String(i).padStart(3, "0")}`,
      seed,
      variant,
      status: failMode ? "failed" : "passed",
      startOffsetMs,
      durationMs,
      elbow: rnd() < 0.5 ? 1 : -1,
      failMode,
      failAt,
      metrics: {
        reward,
        steps: Math.round(durationMs / 50),
        graspAttempts: failMode === "grasp_slip" || failMode === "missed_approach" ? intBetween(rnd, 2, 3) : 1,
      },
    } satisfies Sim;
  });

  const run: Run = {
    id,
    createdAt: new Date().toISOString(),
    policy,
    environmentId: env.id,
    environmentName: env.name,
    task,
    fanout,
    stage: "done",
    progress: { label: `Scored ${fanout} rollouts`, done: fanout, total: fanout },
    sims,
    gate: { metric: "pass_rate", threshold: 0.8, regressionTolerancePp: 2, baseline },
  };

  return freezeAtMs === undefined ? run : freeze(run, freezeAtMs);
}

/**
 * Rewind a finished run to `atMs`, so a fixture can show a fan-out mid-flight. Unsettled rollouts
 * lose their outcome: the UI must not know how a running episode ends.
 */
export function freeze(run: Run, atMs: number): Run {
  const sims = run.sims.map((s): Sim => {
    if (atMs >= s.startOffsetMs + s.durationMs) return s;
    const started = atMs >= s.startOffsetMs;
    // A doomed rollout reveals its failure mode the moment the harness detects it, not at the end.
    const revealed = started && s.failAt !== null && atMs >= s.startOffsetMs + s.failAt * s.durationMs;
    return {
      ...s,
      status: started ? "running" : atMs >= s.startOffsetMs - 450 ? "booting" : "queued",
      failMode: revealed ? s.failMode : null,
      failAt: revealed ? s.failAt : null,
    };
  });
  const done = sims.filter((s) => s.status === "passed" || s.status === "failed").length;
  const stage: RunStage = done === sims.length ? "scoring" : done > 0 ? "rollout" : atMs > 0 ? "booting" : "provisioning";
  return {
    ...run,
    stage,
    sims,
    progress: { label: STAGE_LABEL[stage], done, total: sims.length },
  };
}

export const STAGE_LABEL: Record<RunStage, string> = {
  provisioning: "Provisioning GPU containers",
  booting: "Booting simulator instances",
  rollout: "Running rollouts",
  scoring: "Scoring episodes",
  done: "Complete",
};

/** Exported for the fixture validator, which asserts every mode is reachable. */
export const ALL_FAIL_MODES = FAIL_MODES;
