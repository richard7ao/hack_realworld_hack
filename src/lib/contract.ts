import { z } from "zod";

/**
 * One registry, three consumers:
 *   src/app/api/[...path]  -- the proxy parses nothing, but picks the fixture by `fixture`/`pickBy`
 *   src/lib/client.ts      -- fetchTyped() parses every response with `response`
 *   fixtures/validate.ts   -- parses fixtures/<fixture>.json with the same schema
 *
 * Frozen for the Modal backend: add optional fields only. See docs/API.md.
 */

/** Domain randomisation applied to one rollout. This is what makes 100 runs of one task differ. */
export const Variant = z.object({
  lighting: z.number().min(0).max(1),
  friction: z.number().min(0).max(2),
  objectDx: z.number().min(-1).max(1),
  objectDy: z.number().min(-1).max(1),
  distractors: z.number().int().min(0).max(6),
  cameraJitter: z.number().min(0).max(1),
});
export type Variant = z.infer<typeof Variant>;

export const SIM_STATUSES = ["queued", "booting", "running", "passed", "failed"] as const;
export const SimStatus = z.enum(SIM_STATUSES);
export type SimStatus = z.infer<typeof SimStatus>;

export const FAIL_MODES = ["missed_approach", "grasp_slip", "collision", "dropped_outside", "timeout"] as const;
export const FailMode = z.enum(FAIL_MODES);
export type FailMode = z.infer<typeof FailMode>;

export const FAIL_LABEL: Record<FailMode, string> = {
  missed_approach: "Missed approach",
  grasp_slip: "Grasp slipped",
  collision: "Collision",
  dropped_outside: "Dropped outside bin",
  timeout: "Timed out",
};

/**
 * One simulation. `startOffsetMs` and `durationMs` are the episode's wall-clock script: the client
 * replays the arm motion against them, so the grid stays smooth between 1 s polls.
 *
 * `failMode`/`failAt` must be reported as soon as the backend knows them -- mid-episode, not only at
 * completion -- otherwise a doomed rollout animates as a success and then snaps on the next poll.
 */
export const Sim = z.object({
  id: z.string(),
  seed: z.number().int(),
  variant: Variant,
  status: SimStatus,
  startOffsetMs: z.number().min(0),
  durationMs: z.number().positive(),
  /** Which way the elbow bends. Cosmetic; varies the 100 cells so they do not look cloned. */
  elbow: z.union([z.literal(-1), z.literal(1)]),
  failMode: FailMode.nullable(),
  /** Progress in 0..1 where the episode goes wrong. Null on a clean run. */
  failAt: z.number().min(0).max(1).nullable(),
  metrics: z.object({
    reward: z.number(),
    steps: z.number().int().nonnegative(),
    graspAttempts: z.number().int().nonnegative(),
  }),
});
export type Sim = z.infer<typeof Sim>;

export const RUN_STAGES = ["provisioning", "booting", "rollout", "scoring", "done"] as const;
export const RunStage = z.enum(RUN_STAGES);
export type RunStage = z.infer<typeof RunStage>;

/** The CI gate. `baseline` is the previous green run on the default branch, or null on a first run. */
export const Gate = z.object({
  metric: z.literal("pass_rate"),
  threshold: z.number().min(0).max(1),
  /** How far below baseline a run may land and still pass, in percentage points. */
  regressionTolerancePp: z.number().min(0).max(100),
  baseline: z.object({ ref: z.string(), passRate: z.number().min(0).max(1), n: z.number().int().positive() }).nullable(),
});
export type Gate = z.infer<typeof Gate>;

export const Run = z.object({
  id: z.string(),
  createdAt: z.string(),
  policy: z.object({ name: z.string(), commit: z.string(), branch: z.string() }),
  environmentId: z.string(),
  environmentName: z.string(),
  task: z.string(),
  fanout: z.number().int().positive(),
  /** How many rollouts run at once. Fewer workers than rollouts means later ones queue. */
  concurrency: z.number().int().positive(),
  stage: RunStage,
  progress: z.object({ label: z.string(), done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  sims: z.array(Sim),
  gate: Gate,
});
export type Run = z.infer<typeof Run>;

export const Environment = z.object({
  id: z.string(),
  name: z.string(),
  blurb: z.string(),
  objects: z.array(z.string()),
  difficulty: z.enum(["easy", "medium", "hard"]),
  /** Suggested tasks, offered as one-tap chips on the drop screen. */
  tasks: z.array(z.string()),
});
export type Environment = z.infer<typeof Environment>;

export const EnvironmentsResponse = z.object({ environments: z.array(Environment) });
export const RunResponse = Run;

export const CreateRunRequest = z.object({
  environmentId: z.string().min(1),
  task: z.string().min(3).max(240),
  fanout: z.number().int().min(1).max(256),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CreateRunResponse = z.object({
  ok: z.boolean(),
  runId: z.string().nullable(),
  error: z.string().nullable(),
});

export const endpoints = {
  environments: { method: "GET", path: "/environments", response: EnvironmentsResponse, fixture: "environments" },
  createRun: { method: "POST", path: "/runs", response: CreateRunResponse, fixture: "run-created", request: CreateRunRequest },
  run: { method: "GET", path: "/runs/:id", response: RunResponse, fixture: "runs", pickBy: "id" },
} as const;

export type EndpointName = keyof typeof endpoints;
export type ResponseOf<N extends EndpointName> = z.infer<(typeof endpoints)[N]["response"]>;

/** Substitute `:param` segments. Keeps path building in one place. */
export function buildPath<N extends EndpointName>(name: N, params: Record<string, string> = {}): string {
  return endpoints[name].path.replace(/:(\w+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`buildPath(${name}): missing param "${k}"`);
    return encodeURIComponent(v);
  });
}
