/**
 * mulberry32: a 32-bit PRNG, seeded and reproducible. The whole fallback run is derived from one
 * seed, so a demo replays identically on any machine and a bug reported as "sim-042 looks wrong"
 * is reproducible from its seed alone.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A float in [lo, hi). */
export const between = (rnd: () => number, lo: number, hi: number) => lo + rnd() * (hi - lo);

/** An integer in [lo, hi]. */
export const intBetween = (rnd: () => number, lo: number, hi: number) => Math.floor(between(rnd, lo, hi + 1));

/** One element, weighted. Weights need not sum to 1. */
export function pickWeighted<T>(rnd: () => number, items: readonly [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let roll = rnd() * total;
  for (const [item, w] of items) {
    roll -= w;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]![0];
}

/** Hash a string to a stable 32-bit seed, so a run id alone determines its rollouts. */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
