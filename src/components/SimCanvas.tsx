"use client";
import { useEffect, useRef } from "react";
import type { Sim } from "../lib/contract";
import type { CellState } from "../lib/replay";
import { cellStateAt } from "../lib/replay";
import { scene } from "../lib/sim/arm";
import { drawCell, FLASH_MS, sizeCanvas } from "../lib/sim/draw";

/**
 * One simulation, animated on its own clock. Used where there are a handful on screen -- the
 * landing page previews and the detail drawer. The hundred-cell grid does NOT use this: it drives
 * every cell from a single shared frame loop instead. See SimGrid.
 */
export function SimCanvas({ sim, loop = false, speed = 1, className = "", paused = false, onState }: {
  sim: Sim;
  /** Restart from zero once the episode ends, with a short beat in between. */
  loop?: boolean;
  speed?: number;
  className?: string;
  paused?: boolean;
  /** Fires when the replayed state changes, so a caption can track the loop rather than the outcome. */
  onState?: (state: CellState) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sc = scene(sim);
    const span = sim.startOffsetMs + sim.durationMs;
    const cycle = span + 900;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0;
    let reported: CellState | null = null;

    const frame = (now: number) => {
      const size = sizeCanvas(canvas, dpr);
      if (size) {
        // A still render shows the finished episode, which is the informative frame. It lands past
        // the flash window, because settling instant plus zero elapsed is peak flash.
        const run = still || paused ? span + FLASH_MS : ((now - t0) * speed) % (loop ? cycle : Number.MAX_SAFE_INTEGER);
        const elapsedMs = loop ? run : Math.min(run, span + FLASH_MS);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const state: CellState = cellStateAt(sim, elapsedMs);
        drawCell({ ctx, w: size.w, h: size.h, sim, scene: sc, state, elapsedMs });
        if (state !== reported) {
          reported = state;
          onState?.(state);
        }
      }
      if (!still && !paused) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sim, loop, speed, paused, onState]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
