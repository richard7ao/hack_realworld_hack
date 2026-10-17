"use client";
import { useEffect } from "react";
import { FAIL_LABEL, type Sim } from "../../../lib/contract";
import type { CellState } from "../../../lib/replay";
import { SimCanvas } from "../../../components/SimCanvas";

/** One rollout, big enough to see what went wrong, with the exact conditions that produced it. */
export function SimDrawer({ sim, state, onClose }: { sim: Sim; state: CellState; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const settled = state === "passed" || state === "failed";
  const badge = state === "passed"
    ? { ink: "text-pass-ink", bg: "bg-pass", glyph: "✓", word: "Passed" }
    : state === "failed"
      ? { ink: "text-fail", bg: "bg-fail", glyph: "✕", word: "Failed" }
      : { ink: "text-run", bg: "bg-run", glyph: "·", word: state === "running" ? "Running" : state === "booting" ? "Booting" : "Queued" };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Rollout ${sim.id}`}>
      <button type="button" aria-label="Close details" onClick={onClose} className="fk-fade absolute inset-0 cursor-default bg-black/25" />
      <aside className="fk-slide-in relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto bg-white shadow-[-20px_0_60px_rgb(0_0_0/0.18)]">
        <header className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div>
            <span className="e-mono text-[12px] uppercase tracking-[0.06em] text-muted">Rollout</span>
            <h2 className="e-h mt-1 text-[28px]">{sim.id}</h2>
            <p className={`mt-2 inline-flex items-center gap-2 text-[14px] ${badge.ink}`}>
              <span aria-hidden className={`grid size-5 place-items-center rounded-full text-[11px] font-bold text-white ${badge.bg}`}>{badge.glyph}</span>
              {badge.word}
              {sim.failMode && ` · ${FAIL_LABEL[sim.failMode]}`}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="e-pill e-ghost min-h-0 px-3 py-1.5 text-[16px] leading-none">&times;</button>
        </header>

        <div className="border-b border-line bg-[#FBFBFC] p-4">
          <SimCanvas sim={{ ...sim, startOffsetMs: 0 }} loop className="block aspect-[5/4] w-full rounded-lg bg-white" />
          <p className="mt-2 text-center text-[12px] text-muted">Replaying the recorded episode on a loop.</p>
        </div>

        <div className="flex flex-col gap-6 p-5">
          <Section title="Domain randomisation">
            <Row k="Lighting" v={sim.variant.lighting.toFixed(2)} />
            <Row k="Surface friction" v={sim.variant.friction.toFixed(2)} />
            <Row k="Object offset" v={`${sim.variant.objectDx >= 0 ? "+" : ""}${sim.variant.objectDx.toFixed(2)}, ${sim.variant.objectDy >= 0 ? "+" : ""}${sim.variant.objectDy.toFixed(2)}`} />
            <Row k="Distractors" v={String(sim.variant.distractors)} />
            <Row k="Camera jitter" v={sim.variant.cameraJitter.toFixed(2)} />
          </Section>

          <Section title="Episode">
            <Row k="Reward" v={settled ? sim.metrics.reward.toFixed(3) : "—"} />
            <Row k="Steps" v={String(sim.metrics.steps)} />
            <Row k="Grasp attempts" v={String(sim.metrics.graspAttempts)} />
            <Row k="Duration" v={`${(sim.durationMs / 1000).toFixed(1)}s`} />
            <Row k="Started at" v={`+${(sim.startOffsetMs / 1000).toFixed(1)}s`} />
            {sim.failAt !== null && <Row k="Failed at" v={`${(sim.failAt * 100).toFixed(0)}% through`} />}
          </Section>

          <Section title="Reproduce">
            <Row k="Seed" v={String(sim.seed)} />
            <p className="e-mono mt-2 overflow-x-auto whitespace-nowrap rounded-lg bg-[#F6F6F7] px-3 py-2.5 text-[11px] text-ink">
              forkbench replay --seed {sim.seed}
            </p>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="e-lbl mb-3">{title}</h3>
      <dl className="flex flex-col gap-1.5">{children}</dl>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 pb-1.5 text-[14px]">
      <dt className="text-muted">{k}</dt>
      <dd className="e-mono tabular-nums">{v}</dd>
    </div>
  );
}
