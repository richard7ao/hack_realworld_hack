import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CreateRunRequest, Run } from "../contract";
import { generateRun } from "../sim/generate";
import { environmentById, ENVIRONMENTS } from "../sim/environments";

/**
 * Fixture-mode run storage. Server-only.
 *
 * Runs started in this process are kept in memory so the bench shows the environment and task the
 * user actually chose, rather than a canned one. Anything else falls back to the committed
 * fixtures, then to deterministic regeneration from the id, so a shared link or a dev-server
 * restart never produces a 404 in front of an audience.
 */
const started = new Map<string, Run>();

export class UnknownEnvironment extends Error {
  constructor(id: string) {
    super(`Unknown environment "${id}".`);
  }
}

const FIXTURES = join(process.cwd(), "fixtures");
let committed: Map<string, Run> | null = null;

function fixtureRuns(): Map<string, Run> {
  if (!committed) {
    const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, "runs.json"), "utf8"));
    committed = new Map(Run.array().parse(raw).map((r) => [r.id, r]));
  }
  return committed;
}

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

/** A short, URL-safe, human-readable run id. */
const newRunId = () => `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Start a run. Throws on an environment id the catalogue does not know: substituting a default
 * would show the user a run in an environment they never chose.
 */
export function createRun(body: CreateRunRequest): Run {
  const env = environmentById(body.environmentId);
  if (!env) throw new UnknownEnvironment(body.environmentId);
  const id = newRunId();
  const run = generateRun({ id, environmentId: env.id, task: body.task, fanout: body.fanout });
  started.set(id, run);
  // The demo does not need an eviction policy, but an unbounded map in a long-lived server does.
  if (started.size > 50) started.delete(started.keys().next().value!);
  return run;
}

export function getRun(id: string): Run {
  return started.get(id) ?? fixtureRuns().get(id) ?? regenerate(id);
}

/** Last resort: a stable run for an id nobody has seen, so the page always renders something real. */
function regenerate(id: string): Run {
  return generateRun({ id, environmentId: ENVIRONMENTS[0]!.id, task: ENVIRONMENTS[0]!.tasks[0]!, fanout: 100 });
}
