"use client";
import { useEffect, useRef } from "react";
import type { Sim } from "../lib/contract";
import type { CellState } from "../lib/replay";
import { cellStateAt } from "../lib/replay";
import { scene } from "../lib/sim/arm";
import { drawCell, FLASH_MS, sizeCanvas } from "../lib/sim/draw";

/**
 * One simulation, replayed from the start of its own episode on its own clock. Used where only a
 * handful are on screen: the landing previews, the sidebar and the detail drawer. The hundred-cell
 * grid does not use this; it drives every cell from one shared frame loop. See SimGrid.
 *
 * The frame loop restarts only when the episode script itself changes. Callers re-render many
 * times a second while a run replays, and a loop keyed on object identity would reset to frame
 * zero on every one of those renders and never visibly move.
 */
const scriptKey = (s: Sim) => `${s.id}|${s.seed}|${s.durationMs}|${s.failMode}|${s.failAt}|${s.elbow}`;

export function SimCanvas({ sim, loop = false, speed = 1, className = "", paused = false, ring = true, onState, follow }: {
  sim: Sim;
  /** Restart once the episode ends, with a short beat in between. */
  loop?: boolean;
  speed?: number;
  className?: string;
  paused?: boolean;
  /** Draw the coloured status border. Off for large single previews. */
  ring?: boolean;
  /** Fires when the replayed state changes, so a caption can track the loop rather than the outcome. */
  onState?: (state: CellState) => void;
  /**
   * Track the run's replay clock instead of looping the episode. For a rollout that has not
   * settled, a loop would play its ending, which has not happened yet.
   */
  follow?: React.RefObject<number>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Read through refs so a new callback or a new-but-identical sim object does not restart the loop.
  const latest = useRef({ sim, onState });
  latest.current = { sim, onState };
  const key = scriptKey(sim);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Looping replays from the episode's own start; following keeps the run's real schedule.
    const script: Sim = follow ? latest.current.sim : { ...latest.current.sim, startOffsetMs: 0 };
    const sc = scene(script);
    const span = script.durationMs;
    const cycle = span + 900;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let raf = 0;
    let reported: CellState | null = null;

    const frame = (now: number) => {
      const size = sizeCanvas(canvas, dpr);
      if (size) {
        // A still render shows the finished episode, past the flash window, because settling
        // instant plus zero elapsed is peak flash.
        const t = still || paused ? span + FLASH_MS : (now - t0) * speed;
        const elapsedMs = follow ? follow.current : loop ? t % cycle : Math.min(t, span + FLASH_MS);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const state = cellStateAt(script, elapsedMs);
        drawCell({ ctx, w: size.w, h: size.h, sim: script, scene: sc, state, elapsedMs, ring });
        if (state !== reported) {
          reported = state;
          latest.current.onState?.(state);
        }
      }
      if (!still && !paused) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [key, loop, speed, paused, ring, follow]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
