import test from "node:test";
import assert from "node:assert/strict";
import { between, hashSeed, intBetween, mulberry32, pickWeighted } from "./rng";

/**
 * Guards the one source of randomness the whole fallback run is built from. Every fixture, every
 * variant and every failure mode is derived from a seed through these four helpers, so if the
 * stream drifts, a bug reported as "sim-042 looks wrong" stops being reproducible and every
 * committed fixture silently stops matching the generator that produced it.
 */

const draw = (rnd: () => number, n: number) => Array.from({ length: n }, () => rnd());

test("the same seed replays the same stream, so a run id alone reproduces a report", () => {
  assert.deepEqual(draw(mulberry32(12345), 50), draw(mulberry32(12345), 50));
});

test("different seeds give different streams, so 100 rollouts are not clones", () => {
  const a = draw(mulberry32(1), 50);
  const b = draw(mulberry32(2), 50);
  assert.ok(a.some((v, i) => v !== b[i]), "two seeds produced an identical stream");
});

test("every draw lands in [0, 1), which every caller scales without clamping", () => {
  const rnd = mulberry32(0xbeef);
  for (const v of draw(rnd, 20000)) {
    assert.ok(v >= 0 && v < 1, `draw ${v} escaped [0, 1)`);
  }
});

test("the stream is uniform enough that difficulty weighting is not skewed by the generator", () => {
  const rnd = mulberry32(7);
  const n = 100000;
  let sum = 0;
  const buckets = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const v = rnd();
    sum += v;
    const b = Math.min(3, Math.floor(v * 4));
    buckets[b] = (buckets[b] ?? 0) + 1;
  }
  // Deterministic seed, so these bounds are generous but not flaky.
  assert.ok(Math.abs(sum / n - 0.5) < 0.01, `mean ${sum / n} is not near 0.5`);
  for (const [i, count] of buckets.entries()) {
    assert.ok(Math.abs(count / n - 0.25) < 0.02, `quartile ${i} held ${count / n} of the samples`);
  }
});

test("between stays inside its bounds and actually spans them", () => {
  const rnd = mulberry32(99);
  const vs = Array.from({ length: 5000 }, () => between(rnd, -1, 1));
  for (const v of vs) assert.ok(v >= -1 && v < 1, `between produced ${v}`);
  assert.ok(Math.min(...vs) < -0.95, "never came near the low bound");
  assert.ok(Math.max(...vs) > 0.95, "never came near the high bound");
});

test("between with lo === hi is a constant, so a zero-width variant range is not a NaN", () => {
  const rnd = mulberry32(3);
  for (let i = 0; i < 100; i++) assert.equal(between(rnd, 0.5, 0.5), 0.5);
});

test("intBetween emits whole numbers across the inclusive range, both endpoints included", () => {
  const rnd = mulberry32(2024);
  const seen = new Set<number>();
  for (let i = 0; i < 5000; i++) {
    const v = intBetween(rnd, 0, 6);
    assert.ok(Number.isInteger(v), `intBetween produced ${v}`);
    assert.ok(v >= 0 && v <= 6, `intBetween produced out-of-range ${v}`);
    seen.add(v);
  }
  // distractors is drawn as intBetween(rnd, 0, n): if the endpoints were unreachable the
  // "no clutter" and "max clutter" buckets would never appear in the breakdown panels.
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test("intBetween over a single-value range always returns that value", () => {
  const rnd = mulberry32(5);
  for (let i = 0; i < 100; i++) assert.equal(intBetween(rnd, 4, 4), 4);
});

test("pickWeighted follows the weights, which is what makes a failure breakdown mean something", () => {
  const rnd = mulberry32(31337);
  const counts: Record<string, number> = { rare: 0, mid: 0, common: 0 };
  for (let i = 0; i < 12000; i++) {
    const pick = pickWeighted(rnd, [["rare", 1], ["mid", 3], ["common", 6]] as const);
    assert.notEqual(pick, undefined, "pickWeighted returned nothing");
    counts[pick] = (counts[pick] ?? 0) + 1;
  }
  assert.ok(counts.common! > counts.mid!, `common ${counts.common} did not beat mid ${counts.mid}`);
  assert.ok(counts.mid! > counts.rare!, `mid ${counts.mid} did not beat rare ${counts.rare}`);
  // Weights are 10% / 30% / 60%: generous bands, but tight enough to catch an off-by-one walk.
  assert.ok(Math.abs(counts.rare! / 12000 - 0.1) < 0.03, `rare share ${counts.rare! / 12000}`);
  assert.ok(Math.abs(counts.common! / 12000 - 0.6) < 0.05, `common share ${counts.common! / 12000}`);
});

test("pickWeighted never returns undefined, even when float error eats the last slice", () => {
  const rnd = mulberry32(8);
  const items = Array.from({ length: 20 }, (_, i) => [i, 0.1] as [number, number]);
  for (let i = 0; i < 5000; i++) {
    const pick = pickWeighted(rnd, items);
    assert.ok(typeof pick === "number" && pick >= 0 && pick < 20, `pickWeighted gave ${pick}`);
  }
});

test("a zero-weight entry is effectively never drawn, so an impossible failure mode stays impossible", () => {
  const rnd = mulberry32(4242);
  let impossible = 0;
  for (let i = 0; i < 5000; i++) {
    if (pickWeighted(rnd, [["impossible", 0], ["only", 1]] as const) === "impossible") impossible += 1;
  }
  assert.equal(impossible, 0, "a zero-weight entry was drawn");
});

test("pickWeighted with a single entry returns it whatever the weight", () => {
  const rnd = mulberry32(6);
  for (let i = 0; i < 50; i++) assert.equal(pickWeighted(rnd, [["only", 0]] as const), "only");
});

test("hashSeed is stable for a string, so the same run id always yields the same rollouts", () => {
  assert.equal(hashSeed("run-2026-10-17"), hashSeed("run-2026-10-17"));
  assert.equal(hashSeed(""), hashSeed(""));
});

test("hashSeed separates strings that differ only slightly, including the per-index keys", () => {
  assert.notEqual(hashSeed("run-a"), hashSeed("run-b"));
  // generate.ts hashes `${id}:${i}` per rollout; colliding neighbours would clone two cells.
  const seeds = Array.from({ length: 200 }, (_, i) => hashSeed(`run-x:${i}`));
  assert.equal(new Set(seeds).size, 200, "two rollout keys hashed to the same seed");
});

test("hashSeed always returns a non-negative 32-bit integer, which mulberry32 requires", () => {
  for (const s of ["", "a", "run-000", "é中文", "x".repeat(500), "sim-099:7"]) {
    const h = hashSeed(s);
    assert.ok(Number.isInteger(h), `hashSeed(${JSON.stringify(s)}) gave ${h}`);
    assert.ok(h >= 0 && h <= 0xffffffff, `hashSeed(${JSON.stringify(s)}) gave ${h}`);
  }
});
