"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The replay clock.
 *
 * Two consumers with very different appetites: the grid wants the exact time every frame, and the
 * surrounding chrome wants a number it can render without re-rendering a hundred cells sixty times
 * a second. So the authoritative value lives in a ref that the grid reads from its own frame loop,
 * and only a throttled copy reaches React state.
 */
const PUBLISH_MS = 110;
/** Played past the end so the last rollout's settle flash can finish instead of freezing mid-fade. */
const TAIL_MS = 800;

export type RunClock = {
  /** Exact elapsed ms. Read inside a frame loop; never render from it. */
  ref: React.RefObject<number>;
  /** Elapsed ms, republished about nine times a second. Safe to render. */
  elapsed: number;
  playing: boolean;
  speed: number;
  done: boolean;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  restart: () => void;
  skipToEnd: () => void;
};

export function useRunClock(lengthMs: number): RunClock {
  const fullMs = lengthMs > 0 ? lengthMs + TAIL_MS : 0;
  const ref = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  const set = useCallback((ms: number) => {
    ref.current = ms;
    setElapsed(ms);
  }, []);

  // Someone who asked for less motion gets the finished run, not a silent animation they cannot see.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      set(fullMs);
      setPlaying(false);
    }
  }, [fullMs, set]);

  useEffect(() => {
    if (!playing || fullMs <= 0) return;
    let raf = 0;
    let last: number | null = null;
    let published = 0;
    const frame = (now: number) => {
      last ??= now;
      ref.current = Math.min(fullMs, ref.current + (now - last) * speed);
      last = now;
      if (now - published > PUBLISH_MS) {
        published = now;
        setElapsed(ref.current);
      }
      if (ref.current >= fullMs) {
        setElapsed(fullMs);
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, fullMs]);

  return {
    ref,
    elapsed,
    playing,
    speed,
    done: elapsed >= lengthMs && lengthMs > 0,
    setPlaying,
    setSpeed,
    restart: useCallback(() => { set(0); setPlaying(true); }, [set]),
    skipToEnd: useCallback(() => { set(fullMs); setPlaying(false); }, [set, fullMs]),
  };
}
