"use client";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { Sim } from "../../../lib/contract";
import { cellStateAt, type CellState } from "../../../lib/replay";
import { scene, type Scene } from "../../../lib/sim/arm";
import { drawCell, sizeCanvas } from "../../../lib/sim/draw";

/**
 * A hundred simulations on one screen.
 *
 * The cost model is the whole design. A React render per cell per frame is out of the question, so
 * the DOM here is built once and never updated: each cell is a static button wrapping a static
 * canvas. A single frame loop then walks the array and repaints only what moved -- the rollouts
 * actually running, plus any cell whose state just changed. With a bounded worker pool only about
 * a third of the grid is live at once, so a hundred cells cost about thirty repaints a frame.
 */
const FLASH_MS = 700;

export function SimGrid({ sims, clockRef, onOpen, dimmed }: {
  sims: Sim[];
  clockRef: React.RefObject<number>;
  onOpen: (id: string) => void;
  /** Rollout ids to keep bright. Null means no filter is active. */
  dimmed: Set<string> | null;
}) {
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const scenes = useMemo<Scene[]>(() => sims.map(scene), [sims]);

  useEffect(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const drawn: (CellState | null)[] = sims.map(() => null);
    // Whether the last frame painted for this cell included the settle flash. The flash lives in
    // the canvas, so the cell needs one more repaint after it ends or the tint is frozen in.
    const tinted: boolean[] = sims.map(() => false);
    let raf = 0;
    let forceAll = true;

    const paint = (i: number, state: CellState, elapsedMs: number) => {
      const canvas = canvases.current[i];
      if (!canvas) return;
      const size = sizeCanvas(canvas, dpr);
      if (!size) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawCell({ ctx, w: size.w, h: size.h, sim: sims[i]!, scene: scenes[i]!, state, elapsedMs });
      drawn[i] = state;
    };

    const frame = () => {
      const elapsedMs = clockRef.current;
      for (let i = 0; i < sims.length; i++) {
        const sim = sims[i]!;
        const state = cellStateAt(sim, elapsedMs);
        // Repaint if it is moving, if it just changed, if its verdict flash is still fading, or
        // if the layout changed underneath us.
        const settledFor = elapsedMs - (sim.startOffsetMs + sim.durationMs);
        const flashing = settledFor >= 0 && settledFor < FLASH_MS;
        if (forceAll || state !== drawn[i] || state === "running" || state === "booting" || flashing || tinted[i]) {
          paint(i, state, elapsedMs);
          tinted[i] = flashing;
        }
      }
      forceAll = false;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // Cells are fluid, so a window resize changes every backing store at once.
    const onResize = () => { forceAll = true; };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [sims, scenes, clockRef]);

  return (
    <ul className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 md:grid-cols-8 xl:grid-cols-10">
      {sims.map((sim, i) => {
        const dim = dimmed !== null && !dimmed.has(sim.id);
        return (
          <li key={sim.id}>
            <button
              type="button"
              onClick={() => onOpen(sim.id)}
              aria-label={`Rollout ${sim.id}, seed ${sim.seed}. Open details.`}
              style={{ "--d": `${Math.min(i, 40) * 14}ms` } as CSSProperties}
              className={`e-cell fk-pop block w-full cursor-pointer transition-opacity duration-300 hover:shadow-[0_6px_18px_rgb(0_0_0/0.12)] ${dim ? "opacity-20" : "opacity-100"}`}
            >
              <canvas ref={(el) => { canvases.current[i] = el; }} className="block aspect-[5/4] w-full" />
              <span className="e-mono pointer-events-none absolute bottom-0.5 left-1 text-[8px] leading-none text-muted/70">
                {sim.id.replace("sim-", "")}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
