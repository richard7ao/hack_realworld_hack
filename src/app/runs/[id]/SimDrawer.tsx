"use client";
import { useEffect } from "react";
import { FAIL_LABEL, type Sim } from "../../../lib/contract";
import type { CellState } from "../../../lib/replay";
import { SimCanvas } from "../../../components/SimCanvas";
import { Glyph } from "../../../components/ui";

const WORD: Record<CellState, string> = { queued: "Queued", booting: "Booting", running: "Running", passed: "Passed", failed: "Failed" };

/** One rollout, big enough to see what went wrong, with the exact conditions that produced it. */
export function SimDrawer({ sim, state, clockRef, onClose }: {
  sim: Sim;
  state: CellState;
  clockRef: React.RefObject<number>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const settled = state === "passed" || state === "failed";
  const glyph = state === "passed" ? "pass" : state === "failed" ? "fail" : "idle";
  const ink = state === "passed" ? "text-pass" : state === "failed" ? "text-fail" : "text-brand";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Rollout ${sim.id}`}>
      <button type="button" aria-label="Close details" onClick={onClose} className="a-fade absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[2px]" />
      <aside className="a-slide relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto bg-surface shadow-[-24px_0_64px_rgb(11_14_20/0.22)]">
        <header className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div>
            <span className="label">Rollout</span>
            <h2 className="h2 mono mt-1.5 text-[26px]">{sim.id}</h2>
            <p className={`mt-2 inline-flex items-center gap-2 text-[14px] font-semibold ${ink}`}>
              <Glyph state={glyph} />
              {WORD[state]}
              {sim.failMode && <span className="font-normal text-muted">{FAIL_LABEL[sim.failMode]}</span>}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="pill pill-ghost size-9 shrink-0 p-0 text-[17px] leading-none">&times;</button>
        </header>

        <div className="border-b border-line bg-[#FAFBFC] p-4">
          <SimCanvas sim={sim} loop={settled} follow={settled ? undefined : clockRef} ring={false} className="block aspect-[5/4] w-full rounded-[10px] bg-surface shadow-[0_1px_2px_rgb(11_14_20/0.05)]" />
          <p className="mt-2.5 text-center text-[12px] text-muted">{settled ? "Replaying the recorded episode on a loop." : "Live. Following the run as it plays."}</p>
        </div>

        <div className="flex flex-col gap-6 p-5">
          <Section title="Domain randomisation">
            <Row k="Lighting" v={sim.variant.lighting.toFixed(2)} />
            <Row k="Surface friction" v={sim.variant.friction.toFixed(2)} />
            <Row k="Object offset" v={`${fixed(sim.variant.objectDx)}, ${fixed(sim.variant.objectDy)}`} />
            <Row k="Distractors" v={String(sim.variant.distractors)} />
            <Row k="Camera jitter" v={sim.variant.cameraJitter.toFixed(2)} />
          </Section>

          <Section title="Episode">
            <Row k="Reward" v={settled ? sim.metrics.reward.toFixed(3) : "–"} />
            <Row k="Steps" v={String(sim.metrics.steps)} />
            <Row k="Grasp attempts" v={String(sim.metrics.graspAttempts)} />
            <Row k="Duration" v={`${(sim.durationMs / 1000).toFixed(1)}s`} />
            <Row k="Started at" v={`+${(sim.startOffsetMs / 1000).toFixed(1)}s`} />
            {sim.failAt !== null && <Row k="Failed at" v={`${(sim.failAt * 100).toFixed(0)}% through`} />}
          </Section>

          <Section title="Reproduce">
            <Row k="Seed" v={String(sim.seed)} />
            <p className="mono mt-2.5 overflow-x-auto whitespace-nowrap rounded-[10px] bg-[#0B0E14] px-3.5 py-3 text-[11.5px] text-[#C8E6FF]">
              forkbench replay --seed {sim.seed}
            </p>
          </Section>
        </div>
      </aside>
    </div>
  );
}

const fixed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="label mb-3">{title}</h3>
      <dl className="flex flex-col gap-2">{children}</dl>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-soft pb-2 text-[13.5px]">
      <dt className="text-muted">{k}</dt>
      <dd className="mono text-ink">{v}</dd>
    </div>
  );
}
