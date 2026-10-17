"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { CreateRunRequest, FAIL_LABEL, type Environment, type Sim } from "../../lib/contract";
import { errorText, fetchTyped } from "../../lib/client";
import { ENVIRONMENTS } from "../../lib/sim/environments";
import { generateRun } from "../../lib/sim/generate";
import { Logo } from "../../components/Logo";
import { SimCanvas } from "../../components/SimCanvas";
import { ErrorNote, WRAP } from "../../components/ui";
import { useEndpoint } from "../../lib/useEndpoint";

const FANOUTS = [25, 50, 100] as const;

const DIFFICULTY: Record<Environment["difficulty"], string> = {
  easy: "bg-pass-soft text-pass",
  medium: "bg-warn-soft text-warn",
  hard: "bg-fail-soft text-fail",
};

/** Where the looping previews float, on screens wide enough to have room beside the column. */
const FLOAT_AT = [
  "left-[26px] top-[150px] -rotate-[5deg]",
  "left-[104px] top-[486px] rotate-[4deg]",
  "right-[30px] top-[128px] rotate-[5deg]",
  "right-[108px] top-[470px] -rotate-[4deg]",
];

export default function Page() {
  const router = useRouter();
  const [envId, setEnvId] = useState(ENVIRONMENTS[0]!.id);
  const [task, setTask] = useState(ENVIRONMENTS[0]!.tasks[0]!);
  const [fanout, setFanout] = useState<number>(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The catalogue comes from the API, so live mode lists what the backend can actually run. The
  // bundled copy is only a first paint; in fixture mode the two are identical.
  const { data: catalogue } = useEndpoint("environments");
  const environments = catalogue?.environments.length ? catalogue.environments : ENVIRONMENTS;
  const env = environments.find((e) => e.id === envId) ?? environments[0]!;

  // One clean run and three distinct failures: the four stories a viewer should learn to read.
  const previews = useMemo(() => {
    const pool = generateRun({ id: "landing-preview", environmentId: "cluttered-desk", task: "preview", fanout: 140, skill: 0.5 }).sims;
    const pick = (match: (s: Sim) => boolean) => pool.find(match);
    return [
      pick((s) => s.status === "passed"),
      pick((s) => s.failMode === "grasp_slip"),
      pick((s) => s.failMode === "collision"),
      pick((s) => s.failMode === "missed_approach"),
    ].flatMap((s) => (s ? [{ ...s, startOffsetMs: 0 }] : []));
  }, []);

  function choose(next: Environment) {
    setEnvId(next.id);
    setTask(next.tasks[0]!);
  }

  async function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = CreateRunRequest.safeParse({ environmentId: env.id, task: task.trim(), fanout });
    if (!body.success) return setError(body.error.issues[0]?.message ?? "Check the task description.");
    setBusy(true);
    try {
      const res = await fetchTyped("createRun", { body: body.data });
      if (!res.ok || !res.runId) throw new Error(res.error ?? "The run did not start.");
      router.push(`/runs/${encodeURIComponent(res.runId)}`);
    } catch (err) {
      setError(`Could not start the run. ${errorText(err)}`);
      setBusy(false);
    }
  }

  return (
    <div className="field relative overflow-hidden">
      <header className="relative z-10 border-b border-line/70 bg-surface/70 backdrop-blur-sm">
        <div className={`${WRAP} flex h-[62px] items-center justify-between gap-3`}>
          <Logo />
          <nav className="flex items-center gap-1.5">
            <Link href="/runs/run-regression" className="hidden rounded-full px-3.5 py-2 text-[14px] font-medium text-muted transition-colors hover:text-ink sm:block">
              A failing run
            </Link>
            <Link href="/runs/run-demo" className="pill pill-dark">See a finished run</Link>
          </nav>
        </div>
      </header>

      {previews.map((sim, i) => (
        <Preview key={sim.id} sim={sim} at={FLOAT_AT[i]!} delay={i * -1.6} />
      ))}

      <main className={`${WRAP} relative flex flex-col items-center pb-24 pt-16 text-center md:pt-20`}>
        <p className="a-pop eyebrow mb-5">Policy evaluation, as a merge gate</p>
        <h1 className="h1 a-blur-in text-[46px] md:text-[86px]">
          <span className="block">Ship the policy</span>
          <span className="relative mt-1 inline-block">
            <span aria-hidden className="absolute -inset-x-3 inset-y-1 -z-10 rounded-2xl bg-brand-soft" />
            <span className="text-brand">only if it holds.</span>
          </span>
        </h1>
        <p style={{ "--d": "140ms" } as CSSProperties} className="a-pop mx-auto mt-7 max-w-[620px] text-[17px] leading-[1.5] text-muted md:text-[19px]">
          Drop in an environment and a task. Forkbench fans your policy out across a hundred randomised
          simulations, watches every one of them, and gates the merge on the result.
        </p>

        <form onSubmit={run} aria-label="New evaluation run" className="mt-12 w-full max-w-[880px] text-left">
          <fieldset className="a-pop" style={{ "--d": "220ms" } as CSSProperties}>
            <legend className="label mb-3">Environment</legend>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {environments.map((candidate) => {
                const on = candidate.id === env.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => choose(candidate)}
                    className={`card flex h-full cursor-pointer flex-col p-4 text-left transition-all duration-150 ${on ? "ring-2 ring-brand" : "hover:-translate-y-0.5 hover:shadow-lift"}`}
                  >
                    <span className="text-[15px] font-semibold leading-tight tracking-[-0.015em]">{candidate.name}</span>
                    <span className="mt-1.5 block flex-1 text-[13px] leading-snug text-muted">{candidate.blurb}</span>
                    <span className="mt-3 flex items-center gap-2">
                      <span className={`rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.05em] ${DIFFICULTY[candidate.difficulty]}`}>
                        {candidate.difficulty}
                      </span>
                      {on && <span className="text-[11px] font-semibold text-brand">Selected</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="a-pop mt-8" style={{ "--d": "290ms" } as CSSProperties}>
            <label htmlFor="task" className="label mb-3 block">Task</label>
            <div className="flex flex-col gap-2 rounded-[26px] bg-surface p-2 shadow-lift ring-1 ring-line sm:flex-row sm:items-center sm:rounded-full">
              <span aria-hidden className="hidden pl-3.5 text-muted sm:block">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="8" width="18" height="12" rx="3" />
                  <path d="M12 8V4M8 4h8" />
                  <circle cx="9" cy="14" r="1.2" fill="currentColor" />
                  <circle cx="15" cy="14" r="1.2" fill="currentColor" />
                </svg>
              </span>
              <input
                id="task"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                maxLength={240}
                placeholder="Describe the task in one line"
                className="min-w-0 flex-1 rounded-full bg-transparent px-3.5 py-2.5 text-[16px] outline-none placeholder:text-faint"
              />
              <button type="submit" disabled={busy} className="pill pill-dark h-11 shrink-0 px-6">
                {busy ? "Starting…" : `Run ${fanout} simulations`}
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {env.tasks.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setTask(suggestion)} className={`chip ${suggestion === task ? "chip-on" : ""}`}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>

          <div className="a-pop mt-7 flex flex-wrap items-center justify-between gap-4" style={{ "--d": "350ms" } as CSSProperties}>
            <div className="flex items-center gap-3">
              <span className="label">Fan-out</span>
              <div className="flex overflow-hidden rounded-full border border-line bg-surface p-0.5">
                {FANOUTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={n === fanout}
                    onClick={() => setFanout(n)}
                    className={`mono cursor-pointer rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors ${n === fanout ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[13px] text-muted">
              Gate: pass rate lower bound clears 80%, with no more than 2pp regression on <span className="mono text-ink-2">main</span>.
            </p>
          </div>

          {error && <div className="mt-5"><ErrorNote>{error}</ErrorNote></div>}
        </form>
      </main>
    </div>
  );
}

/**
 * One looping rollout, captioned with how it ends. No status ring: the caption is the status, and
 * a coloured border on a card this size reads as chrome rather than information.
 */
function Preview({ sim, at, delay }: { sim: Sim; at: string; delay: number }) {
  const passed = sim.status === "passed";
  return (
    <div aria-hidden className={`a-float absolute hidden w-[196px] min-[1480px]:block ${at}`} style={{ "--d": `${delay}s` } as CSSProperties}>
      <div className="card overflow-hidden p-2 shadow-lift">
        <SimCanvas sim={sim} loop ring={false} className="block h-[134px] w-full rounded-lg bg-[#FAFBFC]" />
        <p className="mt-2 flex items-center justify-between gap-2 px-1 pb-0.5 text-[11px]">
          <span className="mono text-faint">{sim.id}</span>
          <span className={`flex items-center gap-1.5 font-semibold ${passed ? "text-pass" : "text-fail"}`}>
            <span aria-hidden className={`size-1.5 rounded-full ${passed ? "bg-pass" : "bg-fail"}`} />
            {passed ? "Passed" : sim.failMode ? FAIL_LABEL[sim.failMode] : "Failed"}
          </span>
        </p>
      </div>
    </div>
  );
}
