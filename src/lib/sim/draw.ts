import type { Sim } from "../contract";
import type { CellState } from "../replay";
import { BASE, BIN, FLOOR_Y, OBJ_R, poseAt, progressAt, type Pose, type Pt, type Scene } from "./arm";

/**
 * Draws one simulation cell. Everything a viewer reads off a cell -- the arm, the object, the
 * status ring, the settle flash -- is painted here rather than mirrored into the DOM, because at a
 * hundred cells a React re-render per frame is not affordable but a hundred short canvas paths are.
 */
const INK = "#121722";
const FLOOR = "rgba(11,14,20,0.10)";
const CLUTTER = "#D5D9E0";
const STEEL = "#8A93A3";
const OBJECT = "#E02424";
const LANDED = "#0E9F6E";

export const RING: Record<CellState, string> = {
  queued: "rgba(11,14,20,0.05)",
  booting: "rgba(28,100,242,0.22)",
  running: "rgba(28,100,242,0.45)",
  passed: "#0E9F6E",
  failed: "#E02424",
};

/** Settled verdicts earn a solid border. Live work gets a hairline, so outcomes dominate the grid. */
const RING_WIDTH: Record<CellState, number> = { queued: 1, booting: 1, running: 1, passed: 1.5, failed: 1.5 };
/** An unstarted cell is a slot, not a scene. */
const QUEUED_FILL = "#FAFBFC";

/** The slice of unit space a cell shows. Mapped uniformly, so the arm never stretches. */
const VIEW = { x0: 0, x1: 1, y0: 0.2, y1: 0.93 };
export const FLASH_MS = 700;

type Fit = { X: (u: number) => number; Y: (u: number) => number; s: number };

function fit(w: number, h: number): Fit {
  const s = Math.min(w / (VIEW.x1 - VIEW.x0), h / (VIEW.y1 - VIEW.y0));
  const ox = (w - s * (VIEW.x1 - VIEW.x0)) / 2;
  const oy = (h - s * (VIEW.y1 - VIEW.y0)) / 2;
  return { X: (u) => ox + (u - VIEW.x0) * s, Y: (u) => oy + (u - VIEW.y0) * s, s };
}

const line = (ctx: CanvasRenderingContext2D, f: Fit, a: Pt, b: Pt, width: number, colour: string) => {
  ctx.beginPath();
  ctx.moveTo(f.X(a.x), f.Y(a.y));
  ctx.lineTo(f.X(b.x), f.Y(b.y));
  ctx.lineWidth = width * f.s;
  ctx.lineCap = "round";
  ctx.strokeStyle = colour;
  ctx.stroke();
};

const disc = (ctx: CanvasRenderingContext2D, f: Fit, p: Pt, r: number, colour: string) => {
  ctx.beginPath();
  ctx.arc(f.X(p.x), f.Y(p.y), r * f.s, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
};

/** Gripper: two fingers that splay open and pinch shut, drawn in the forearm's frame. */
function gripper(ctx: CanvasRenderingContext2D, f: Fit, pose: Pose) {
  const spread = 0.016 + pose.grip * 0.030;
  const n = { x: -Math.sin(pose.angle), y: Math.cos(pose.angle) };
  const d = { x: Math.cos(pose.angle), y: Math.sin(pose.angle) };
  for (const side of [1, -1]) {
    const root = { x: pose.tip.x + n.x * spread * side, y: pose.tip.y + n.y * spread * side };
    const toe = { x: root.x + d.x * 0.034, y: root.y + d.y * 0.034 };
    line(ctx, f, root, toe, 0.016, INK);
  }
  line(ctx, f, { x: pose.tip.x - n.x * spread, y: pose.tip.y - n.y * spread }, { x: pose.tip.x + n.x * spread, y: pose.tip.y + n.y * spread }, 0.018, INK);
}

/** The static set dressing: floor, bin and clutter. Identical every frame. */
function stage(ctx: CanvasRenderingContext2D, f: Fit, sc: Scene) {
  ctx.beginPath();
  ctx.moveTo(f.X(0), f.Y(FLOOR_Y));
  ctx.lineTo(f.X(1), f.Y(FLOOR_Y));
  ctx.lineWidth = Math.max(1, 0.012 * f.s);
  ctx.strokeStyle = FLOOR;
  ctx.stroke();

  for (const d of sc.distractors) disc(ctx, f, d, 0.022, CLUTTER);

  // Bin: an open-topped tray, so "in the bin" is legible at 110px wide.
  ctx.beginPath();
  ctx.moveTo(f.X(BIN.x), f.Y(BIN.y));
  ctx.lineTo(f.X(BIN.x), f.Y(BIN.y + BIN.h));
  ctx.lineTo(f.X(BIN.x + BIN.w), f.Y(BIN.y + BIN.h));
  ctx.lineTo(f.X(BIN.x + BIN.w), f.Y(BIN.y));
  ctx.lineWidth = Math.max(1, 0.016 * f.s);
  ctx.lineJoin = "round";
  ctx.strokeStyle = STEEL;
  ctx.stroke();
}

export type DrawArgs = {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  sim: Sim;
  scene: Scene;
  state: CellState;
  /** ms since the run started. */
  elapsedMs: number;
  /**
   * Draw the status border. Indispensable in the grid, where it is the only way to read a
   * hundred states at a glance, and wrong on a single large preview, where it is just a loud
   * border around a picture whose status the surrounding chrome already states.
   */
  ring?: boolean;
};

export function drawCell({ ctx, w, h, sim, scene: sc, state, elapsedMs, ring: withRing = true }: DrawArgs): void {
  const f = fit(w, h);
  ctx.clearRect(0, 0, w, h);

  if (state === "queued") {
    // Nothing has been provisioned yet; show the empty stage so the grid has structure immediately.
    ctx.fillStyle = QUEUED_FILL;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.3;
    stage(ctx, f, { ...sc, distractors: [] });
    ctx.globalAlpha = 1;
    if (withRing) ring(ctx, w, h, RING.queued, 1);
    return;
  }

  stage(ctx, f, sc);

  const p = progressAt(sim, elapsedMs);
  const pose = poseAt(sim, sc, p);

  // A collision shakes the whole arm, which is the only cue that reads at this size.
  const shake = pose.impact > 0 ? Math.sin(elapsedMs / 18) * pose.impact * 0.012 : 0;
  ctx.save();
  ctx.translate(shake * f.s, 0);

  // Pedestal, then the two links, then the joint, so each overlaps the one before cleanly.
  const foot = { x: BASE.x, y: FLOOR_Y };
  line(ctx, f, foot, BASE, 0.05, "rgba(29,29,29,0.22)");
  line(ctx, f, BASE, pose.joint, 0.040, INK);
  line(ctx, f, pose.joint, pose.tip, 0.032, INK);
  disc(ctx, f, BASE, 0.030, INK);
  disc(ctx, f, pose.joint, 0.022, "#FFFFFF");
  ctx.beginPath();
  ctx.arc(f.X(pose.joint.x), f.Y(pose.joint.y), 0.022 * f.s, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, 0.010 * f.s);
  ctx.strokeStyle = INK;
  ctx.stroke();
  gripper(ctx, f, pose);
  ctx.restore();

  disc(ctx, f, pose.object, OBJ_R, pose.landedInBin ? LANDED : OBJECT);

  if (pose.impact > 0) {
    // Impact star at the point of contact.
    ctx.save();
    ctx.globalAlpha = pose.impact;
    ctx.strokeStyle = OBJECT;
    ctx.lineWidth = Math.max(1, 0.012 * f.s);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(f.X(pose.tip.x) + Math.cos(a) * 0.03 * f.s, f.Y(pose.tip.y) + Math.sin(a) * 0.03 * f.s);
      ctx.lineTo(f.X(pose.tip.x) + Math.cos(a) * 0.062 * f.s, f.Y(pose.tip.y) + Math.sin(a) * 0.062 * f.s);
      ctx.stroke();
    }
    ctx.restore();
  }

  // A verdict flashes once as it lands, so a wall of a hundred reads as a stream of results.
  const sinceSettled = elapsedMs - (sim.startOffsetMs + sim.durationMs);
  if ((state === "passed" || state === "failed") && sinceSettled >= 0 && sinceSettled < FLASH_MS) {
    // Build the colour in one piece: ctx.fillStyle validates on assignment, so feeding it a
    // partial "rgba(r,g,b," is silently dropped and leaves the previous opaque colour in place.
    const rgb = state === "passed" ? "14,159,110" : "224,36,36";
    // Four places, not three: at the tail of the window three rounds the alpha to a literal 0.000.
    ctx.fillStyle = `rgba(${rgb},${((1 - sinceSettled / FLASH_MS) * 0.32).toFixed(4)})`;
    ctx.fillRect(0, 0, w, h);
  }

  if (withRing) ring(ctx, w, h, RING[state], RING_WIDTH[state]);
}

/** The status border, drawn inside the cell so it is never clipped. */
function ring(ctx: CanvasRenderingContext2D, w: number, h: number, colour: string, width: number) {
  ctx.beginPath();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.strokeRect(width / 2, width / 2, w - width, h - width);
}

/** Scales the backing store for the display's pixel ratio. Returns the CSS-pixel size to draw in. */
export function sizeCanvas(canvas: HTMLCanvasElement, dpr: number): { w: number; h: number } | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  return { w, h };
}
