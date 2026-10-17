"use client";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { CreateRunRequest, type Environment } from "../lib/contract";
import type { CellState } from "../lib/replay";
import { errorText, fetchTyped } from "../lib/client";
import { ENVIRONMENTS } from "../lib/sim/environments";
import { generateRun } from "../lib/sim/generate";
import { Logo } from "../components/Logo";
import { SimCanvas } from "../components/SimCanvas";
import { ErrorNote, WRAP } from "../components/ui";

const FANOUTS = [25, 50, 100] as const;

const DIFFICULTY_TONE: Record<Environment["difficulty"], string> = {
  easy: "border-pass/40 text-pass",
  medium: "border-warn/50 text-warn",
  hard: "border-fail/40 text-fail",
};

/** Four looping rollouts, floating beside the form: the product's core visual, before you press anything. */
const FLOAT_AT = ["left-10 top-32 -rotate-6", "left-[96px] top-[452px] rotate-[4deg]", "right-12 top-[108px] rotate-[5deg]", "right-[92px] top-[446px] -rotate-[4deg]"];

export default function Page() {
  const router = useRouter();
  const [envId, setEnvId] = useState(ENVIRONMENTS[0]!.id);
  const [task, setTask] = useState(ENVIRONMENTS[0]!.tasks[0]!);
  const [fanout, setFanout] = useState<number>(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const env = ENVIRONMENTS.find((e) => e.id === envId) ?? ENVIRONMENTS[0]!;

  // One pass, one slip, one collision, one miss: the four stories a viewer should recognise.
  const previews = useMemo(() => {
    const pool = generateRun({ id: "landing-preview", environmentId: "cluttered-desk", task: "preview", fanout: 120, skill: 0.5 }).sims;
    const pick = (match: (s: (typeof pool)[number]) => boolean) => pool.find(match);
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
    const body = CreateRunRequest.safeParse({ environmentId: envId, task: task.trim(), fanout });
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
    <div className="theme-e relative overflow-hidden">
      <header className={`${WRAP} relative z-10 flex items-center justify-between gap-3 py-6`}>
        <Logo />
        <a href="/runs/run-demo" className="e-pill e-outline px-4">
          See a finished run
        </a>
      </header>

      {previews.map((sim, i) => (
        <Preview key={sim.id} sim={sim} at={FLOAT_AT[i]!} delay={i * -1.4} />
      ))}

      <main className={`${WRAP} relative flex flex-col items-center pb-20 pt-10 text-center`}>
        <h1 className="e-h fk-blur-in text-[42px] md:text-[80px]">
          <span className="block">Ship the policy</span>
          <span className="rounded-[18px] bg-pistachio px-[0.14em] pb-[0.04em] [box-decoration-break:clone]">only if it holds.</span>
        </h1>
        <p style={{ "--d": "120ms" } as CSSProperties} className="fk-pop mx-auto mt-6 max-w-[660px] text-[17px] leading-[1.45] text-muted md:text-xl md:leading-[1.45]">
          Drop in an environment and a task. Forkbench fans your policy out across a hundred randomised
          simulations, watches every one of them, and gates the merge on the result.
        </p>

        <form onSubmit={run} aria-label="New evaluation run" className="mt-11 w-full max-w-[940px]">
          <fieldset className="fk-pop text-left" style={{ "--d": "200ms" } as CSSProperties}>
            <legend className="e-lbl mb-3">Environment</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {ENVIRONMENTS.map((candidate) => {
                const on = candidate.id === env.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => choose(candidate)}
                    className={`e-tile cursor-pointer p-4 text-left transition-shadow ${on ? "border-forest shadow-[0_0_0_2px_#336138,0_10px_28px_rgb(0_0_0/0.10)]" : "hover:shadow-[0_8px_24px_rgb(0_0_0/0.08)]"}`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-[15px] font-medium leading-tight">{candidate.name}</span>
                      <span className={`e-mono rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.04em] ${DIFFICULTY_TONE[candidate.difficulty]}`}>
                        {candidate.difficulty}
                      </span>
                    </span>
                    <span className="mt-1.5 block text-[13px] leading-snug text-muted">{candidate.blurb}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="fk-pop mt-7 text-left" style={{ "--d": "280ms" } as CSSProperties}>
            <label htmlFor="task" className="e-lbl mb-3">Task</label>
            <div className="flex flex-col gap-2 rounded-[28px] border border-edge bg-white p-2 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_14px_36px_rgb(0_0_0/0.08)] sm:flex-row sm:items-center sm:rounded-full">
              <input
                id="task"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                maxLength={240}
                placeholder="Describe the task in one line"
                className="min-w-0 flex-1 rounded-full bg-transparent px-5 py-3 text-[16px] outline-none placeholder:text-muted/70"
              />
              <button type="submit" disabled={busy} className="inline-flex h-12 flex-none cursor-pointer items-center justify-center gap-2 rounded-full bg-ink px-6 text-[15px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-60">
                {busy ? "Starting…" : `Run ${fanout} simulations`}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12h14" />
                  <path d="M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {env.tasks.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setTask(suggestion)} className={`e-chip cursor-pointer text-[13px] transition-colors ${suggestion === task ? "border-forest bg-pistachio/25" : "hover:border-forest/60"}`}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>

          <div className="fk-pop mt-6 flex flex-wrap items-center justify-between gap-4 text-left" style={{ "--d": "340ms" } as CSSProperties}>
            <div className="flex items-center gap-3">
              <span className="e-lbl">Fan-out</span>
              <div className="flex overflow-hidden rounded-full border border-edge bg-white">
                {FANOUTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={n === fanout}
                    onClick={() => setFanout(n)}
                    className={`e-mono cursor-pointer px-4 py-2 text-[13px] tabular-nums transition-colors ${n === fanout ? "bg-ink text-white" : "text-muted hover:bg-black/[0.04]"}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[13px] text-muted">
              Gate: pass rate lower bound must clear 80%, with no more than 2pp regression on <span className="e-mono">main</span>.
            </p>
          </div>

          {error && <div className="mt-5 text-left"><ErrorNote>{error}</ErrorNote></div>}
        </form>
      </main>
    </div>
  );
}

const PREVIEW_WORD: Record<CellState, string> = { queued: "queued", booting: "booting", running: "running", passed: "pass", failed: "fail" };
const PREVIEW_TONE: Record<CellState, string> = { queued: "text-muted", booting: "text-run", running: "text-run", passed: "text-pass-ink", failed: "text-fail" };

/** One looping rollout, captioned with the state it is actually in rather than how it ends. */
function Preview({ sim, at, delay }: { sim: Parameters<typeof SimCanvas>[0]["sim"]; at: string; delay: number }) {
  const [state, setState] = useState<CellState>("running");
  return (
    <div aria-hidden className={`fk-float absolute hidden w-[188px] min-[1400px]:block ${at}`} style={{ "--d": `${delay}s` } as CSSProperties}>
      <div className="e-tile overflow-hidden p-2 shadow-[0_1px_2px_rgb(0_0_0/0.06),0_14px_36px_rgb(0_0_0/0.10)]">
        <SimCanvas sim={sim} loop className="block h-[132px] w-full" onState={useCallback((s: CellState) => setState(s), [])} />
        <p className="e-mono mt-1 flex justify-between px-1 pb-0.5 text-[10px] uppercase tracking-[0.04em] text-muted">
          <span>{sim.id}</span>
          <span className={PREVIEW_TONE[state]}>{PREVIEW_WORD[state]}</span>
        </p>
      </div>
    </div>
  );
}
