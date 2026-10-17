import test from "node:test";
import assert from "node:assert/strict";
import { drawCell, FLASH_MS, sizeCanvas } from "./draw";
import { poseAt, progressAt, scene } from "./arm";
import { generateRun } from "./generate";
import type { Sim } from "../contract";
import type { CellState } from "../replay";

/**
 * Guards the canvas painter, which has no DOM to assert against and so would otherwise be the one
 * part of the grid nothing can catch. Two classes of bug live here and both are silent at runtime:
 * a colour string the canvas rejects on assignment (the cell keeps the previous colour and nobody
 * throws), and a non-finite coordinate (the path is dropped and the cell simply goes blank).
 *
 * The fake context below reproduces the first of those faithfully: a real ctx.fillStyle validates
 * on assignment and keeps its old value when the new one is invalid. That exact behaviour hid a
 * real bug in this repo, where a colour was assembled in pieces and the partial string was dropped.
 */

const CSS_COLOUR =
  /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+(\.\d+)?|\.\d+)\s*\))$/;

type Entry =
  | { kind: "call"; fn: string; args: number[] }
  | { kind: "prop"; prop: string; value: string | number };

type Recorder = { ctx: CanvasRenderingContext2D; log: Entry[] };

const COORD_CALLS = new Set(["moveTo", "lineTo", "arc", "fillRect", "strokeRect"]);

/** A recording 2D context. Colour setters validate and silently ignore, exactly like the browser. */
function recorder(): Recorder {
  const log: Entry[] = [];
  const fake: Record<string, unknown> = {};

  for (const fn of ["clearRect", "beginPath", "moveTo", "lineTo", "arc", "stroke", "fill",
    "fillRect", "strokeRect", "save", "restore", "translate", "setTransform"]) {
    fake[fn] = (...args: number[]) => { log.push({ kind: "call", fn, args }); };
  }

  // A colour that fails validation is dropped and the previous one stays, so a caller that builds
  // a colour wrongly paints the wrong colour instead of failing.
  for (const prop of ["fillStyle", "strokeStyle"]) {
    let current = "#000000";
    Object.defineProperty(fake, prop, {
      get: () => current,
      set: (value: string) => {
        log.push({ kind: "prop", prop, value });
        if (CSS_COLOUR.test(value)) current = value;
      },
    });
  }

  for (const [prop, initial] of [["lineWidth", 1], ["lineCap", "butt"], ["lineJoin", "miter"], ["globalAlpha", 1]] as const) {
    let current: string | number = initial;
    Object.defineProperty(fake, prop, {
      get: () => current,
      set: (value: string | number) => { log.push({ kind: "prop", prop, value }); current = value; },
    });
  }

  return { ctx: fake as unknown as CanvasRenderingContext2D, log };
}

const sim = (over: Partial<Sim> = {}): Sim => ({
  id: "sim-000", seed: 12345,
  variant: { lighting: 0.5, friction: 1, objectDx: 0, objectDy: 0, distractors: 3, cameraJitter: 0 },
  status: "passed", startOffsetMs: 1000, durationMs: 6000, elbow: 1,
  failMode: null, failAt: null, metrics: { reward: 0.9, steps: 120, graspAttempts: 1 },
  ...over,
});

const W = 110;
const H = 92;

/** Draw one frame and hand back everything that was recorded. */
function paint(s: Sim, state: CellState, elapsedMs: number): Entry[] {
  const r = recorder();
  drawCell({ ctx: r.ctx, w: W, h: H, sim: s, scene: scene(s), state, elapsedMs });
  return r.log;
}

const STATES: CellState[] = ["queued", "booting", "running", "passed", "failed"];
const FAIL_SIMS: Sim[] = [
  sim(),
  sim({ status: "failed", failMode: "collision", failAt: 0.25 }),
  sim({ status: "failed", failMode: "grasp_slip", failAt: 0.55 }),
  sim({ status: "failed", failMode: "missed_approach", failAt: 0.35 }),
  sim({ status: "failed", failMode: "dropped_outside", failAt: 0.80 }),
  sim({ status: "failed", failMode: "timeout", failAt: 0.40, durationMs: 10000 }),
];

const colourAssignments = (log: Entry[]) =>
  log.filter((e): e is Extract<Entry, { kind: "prop" }> =>
    e.kind === "prop" && (e.prop === "fillStyle" || e.prop === "strokeStyle"));

test("every colour the painter assigns is one the canvas will actually accept", () => {
  for (const s of FAIL_SIMS) {
    for (const state of STATES) {
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const log = paint(s, state, s.startOffsetMs + p * s.durationMs);
        for (const e of colourAssignments(log)) {
          assert.equal(typeof e.value, "string", `${e.prop} was assigned a non-string`);
          assert.ok(CSS_COLOUR.test(String(e.value)),
            `${e.prop} got ${JSON.stringify(e.value)} (${s.failMode ?? "clean"}, ${state}, p=${p.toFixed(2)})`);
        }
      }
    }
  }
});

test("no colour is ever a half-built string, the failure the canvas swallows silently", () => {
  // The bug this guards: building "rgba(r,g,b," and appending the alpha afterwards. The canvas
  // drops the partial value without complaint and the cell paints in the previous colour.
  let checked = 0;
  for (const s of FAIL_SIMS) {
    for (const state of ["passed", "failed"] as const) {
      for (const since of [0, 50, 200, 500, 690]) {
        for (const e of colourAssignments(paint(s, state, s.startOffsetMs + s.durationMs + since))) {
          const value = String(e.value);
          assert.ok(!value.trim().endsWith(","), `${e.prop} got a truncated colour ${JSON.stringify(value)}`);
          assert.equal(value.split("(").length, value.split(")").length, `unbalanced colour ${JSON.stringify(value)}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 0, "no colours were inspected, so this test proved nothing");
});

test("no non-finite coordinate ever reaches the canvas, which would blank the cell", () => {
  const run = generateRun({ id: "draw-test", environmentId: "tabletop", task: "pick the block", fanout: 40 });
  assert.ok(run.sims.length === 40);
  for (const s of [...run.sims, ...FAIL_SIMS]) {
    const sc = scene(s);
    for (const state of STATES) {
      for (let p = 0; p <= 1.0001; p += 0.1) {
        const elapsedMs = s.startOffsetMs + p * s.durationMs;
        // The pose feeding the painter must be finite too, or the painter is being blamed for arm.
        const pose = poseAt(s, sc, progressAt(s, elapsedMs));
        assert.ok(Number.isFinite(pose.tip.x) && Number.isFinite(pose.tip.y), `${s.id} gave a non-finite tip`);
        for (const e of paint(s, state, elapsedMs)) {
          if (e.kind !== "call" || !COORD_CALLS.has(e.fn)) continue;
          for (const [i, arg] of e.args.entries()) {
            assert.ok(Number.isFinite(arg),
              `${e.fn} arg ${i} was ${arg} (${s.id}, ${s.failMode ?? "clean"}, ${state}, p=${p.toFixed(2)})`);
          }
        }
      }
    }
  }
});

test("every failure mode in a generated run is covered by the sweep above", () => {
  // Without this the sweep could silently be exercising one code path and still pass.
  const modes = new Set(FAIL_SIMS.map((s) => s.failMode).filter(Boolean));
  assert.deepEqual([...modes].sort(),
    ["collision", "dropped_outside", "grasp_slip", "missed_approach", "timeout"]);
});

test("a queued cell draws the empty stage and no arm at all", () => {
  const s = sim();
  const queued = paint(s, "queued", 0);
  const running = paint(s, "running", s.startOffsetMs + s.durationMs / 2);
  const paths = (log: Entry[]) => log.filter((e) => e.kind === "call" && e.fn === "beginPath").length;
  assert.ok(paths(queued) * 3 < paths(running),
    `queued drew ${paths(queued)} paths against ${paths(running)} for a running cell`);
  // The arm is the only thing that uses arc(); the empty stage has no joints to draw.
  assert.equal(queued.filter((e) => e.kind === "call" && e.fn === "arc").length, 0,
    "a queued cell drew a joint, so it is showing an arm that has not been provisioned");
  assert.ok(running.filter((e) => e.kind === "call" && e.fn === "arc").length > 0,
    "a running cell drew no joints, so the sweep is not reaching the arm");
});

test("the frame is always cleared first, so paints cannot accumulate into a smear", () => {
  for (const s of FAIL_SIMS) {
    for (const state of STATES) {
      for (const p of [0, 0.5, 1]) {
        const log = paint(s, state, s.startOffsetMs + p * s.durationMs);
        const first = log[0];
        assert.ok(first && first.kind === "call" && first.fn === "clearRect",
          `first op was ${JSON.stringify(first)} for ${state} at p=${p}`);
        assert.deepEqual(first.args, [0, 0, W, H], "the clear did not cover the whole cell");
      }
    }
  }
});

/** The alpha of the full-cell flash wash, or null if no flash was painted. */
function flashAlpha(log: Entry[]): number | null {
  const i = log.findIndex((e) => e.kind === "call" && e.fn === "fillRect");
  if (i === -1) return null;
  for (let j = i - 1; j >= 0; j--) {
    const e = log[j];
    if (e && e.kind === "prop" && e.prop === "fillStyle") {
      const m = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/.exec(String(e.value));
      assert.ok(m, `the flash colour ${JSON.stringify(e.value)} is not an rgba wash`);
      return Number(m[1]);
    }
  }
  assert.fail("a flash was painted with no colour set before it");
}

test("the settle flash fades out, so a hundred verdicts read as a stream rather than a strobe", () => {
  for (const state of ["passed", "failed"] as const) {
    const s = sim({ status: state === "passed" ? "passed" : "failed", failMode: state === "failed" ? "collision" : null, failAt: state === "failed" ? 0.25 : null });
    const settled = s.startOffsetMs + s.durationMs;
    let previous = Infinity;
    // The last sample sits one ms inside the window, where a coarsely rounded alpha would
    // collapse to a literal zero and the fade would end early.
    for (const since of [0, 100, 200, 300, 400, 500, 600, FLASH_MS - 1]) {
      const alpha = flashAlpha(paint(s, state, settled + since));
      assert.notEqual(alpha, null, `no flash at ${since}ms into the window`);
      assert.ok(alpha! > 0, `flash alpha was ${alpha} at ${since}ms`);
      assert.ok(alpha! < previous, `flash alpha ${alpha} at ${since}ms did not fall below ${previous}`);
      previous = alpha!;
    }
  }
});

test("no flash is painted outside its window, so a settled cell does not sit tinted", () => {
  const s = sim();
  const settled = s.startOffsetMs + s.durationMs;
  assert.equal(flashAlpha(paint(s, "passed", settled - 1)), null, "flashed before the verdict landed");
  assert.equal(flashAlpha(paint(s, "passed", settled + FLASH_MS)), null, "still flashing at the end of the window");
  assert.equal(flashAlpha(paint(s, "passed", settled + FLASH_MS + 5000)), null, "still flashing long after");
  // An unsettled cell has no verdict to flash, whatever the clock says.
  assert.equal(flashAlpha(paint(s, "running", settled + 10)), null, "a running cell flashed a verdict");
});

/** A canvas stand-in: only the four fields sizeCanvas touches. */
const canvasStub = (clientWidth: number, clientHeight: number, width = 0, height = 0) =>
  ({ clientWidth, clientHeight, width, height }) as unknown as HTMLCanvasElement;

test("sizeCanvas refuses a zero-sized canvas rather than dividing a frame by nothing", () => {
  assert.equal(sizeCanvas(canvasStub(0, 0), 2), null);
  assert.equal(sizeCanvas(canvasStub(120, 0), 2), null);
  assert.equal(sizeCanvas(canvasStub(0, 90), 2), null);
});

test("sizeCanvas scales the backing store by the pixel ratio, so cells are not blurry on retina", () => {
  const canvas = canvasStub(110, 92);
  assert.deepEqual(sizeCanvas(canvas, 2), { w: 110, h: 92 }, "drawing must still happen in CSS pixels");
  assert.equal(canvas.width, 220);
  assert.equal(canvas.height, 184);
});

test("sizeCanvas rounds a fractional ratio and leaves an already-correct backing store alone", () => {
  const canvas = canvasStub(100, 75);
  assert.deepEqual(sizeCanvas(canvas, 1.5), { w: 100, h: 75 });
  assert.deepEqual([canvas.width, canvas.height], [150, 113]);

  // Reassigning canvas.width clears the canvas in a real browser, so an unchanged size must not.
  let writes = 0;
  let backingW = 150;
  let backingH = 113;
  const watched = {
    clientWidth: 100,
    clientHeight: 75,
    get width() { return backingW; },
    set width(v: number) { writes += 1; backingW = v; },
    get height() { return backingH; },
    set height(v: number) { writes += 1; backingH = v; },
  } as unknown as HTMLCanvasElement;
  assert.deepEqual(sizeCanvas(watched, 1.5), { w: 100, h: 75 });
  assert.equal(writes, 0, "the backing store was rewritten at an unchanged size, wiping the frame");
});
