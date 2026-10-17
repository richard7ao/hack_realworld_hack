"use client";
import { memo, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { FAMILIES, FAMILY_LABEL, type BenchmarkCase } from "../lib/contract";
import { cellStateAt, type CellState } from "../lib/replay";
import { cellScript, sceneFor } from "../lib/sim/arm";
import { drawCell, FLASH_MS, sizeCanvas } from "../lib/sim/draw";

/**
 * The CI Bench grid: PickLab-100 as five family bands of twenty tiles.
 *
 * Same cost model as before. The DOM is built once per run; one frame loop walks every canvas and
 * repaints only what moved: running tiles, tiles whose state just changed, and tiles still fading
 * their settle flash (plus one clean frame after, so no tint is frozen in).
 */
export const BenchGrid = memo(function BenchGrid({ cases, clockRef, onOpen, visible }: {
  cases: BenchmarkCase[];
  clockRef: React.RefObject<number>;
  onOpen: (caseId: string) => void;
  /** Case ids to keep bright. Null means no filter. */
  visible: Set<string> | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const ordered = useMemo(() => FAMILIES.map((f) => ({ family: f, cases: cases.filter((c) => c.family === f) })), [cases]);
  const flat = useMemo(() => ordered.flatMap((g) => g.cases), [ordered]);
  const scripts = useMemo(() => flat.map((c) => cellScript(c)), [flat]);
  const scenes = useMemo(() => scripts.map((s) => sceneFor(s)), [scripts]);

  useEffect(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvases = Array.from(root.current?.querySelectorAll("canvas") ?? []);
    const drawn: (CellState | null)[] = flat.map(() => null);
    const tinted: boolean[] = flat.map(() => false);
    let raf = 0;
    let forceAll = true;

    const frame = () => {
      const t = clockRef.current;
      for (let i = 0; i < flat.length; i++) {
        const c = flat[i]!;
        const state = cellStateAt(c, t);
        const since = c.finished_at_ms === null ? -1 : t - c.finished_at_ms;
        const flashing = since >= 0 && since < FLASH_MS;
        if (!(forceAll || state !== drawn[i] || state === "running" || flashing || tinted[i])) continue;
        const canvas = canvases[i];
        const size = canvas && sizeCanvas(canvas, dpr);
        const ctx = size && canvas.getContext("2d");
        if (!ctx || !size) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCell({ ctx, w: size.w, h: size.h, script: scripts[i]!, scene: scenes[i]!, state, elapsedMs: t });
        drawn[i] = state;
        tinted[i] = flashing;
      }
      forceAll = false;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onResize = () => { forceAll = true; };
    window.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, [flat, scripts, scenes, clockRef]);

  let index = 0;
  return (
    <div ref={root} className="flex flex-col gap-4">
      {ordered.map(({ family, cases: group }) => (
        <section key={family} aria-label={FAMILY_LABEL[family]}>
          <h3 className="mb-2 flex items-baseline justify-between text-[12px]">
            <span className="font-semibold uppercase tracking-[0.07em] text-ink-2">{FAMILY_LABEL[family]}</span>
            <span className="mono text-faint">{group.length} cases</span>
          </h3>
          <ul className="grid grid-cols-5 gap-1.5 sm:grid-cols-10">
            {group.map((c) => {
              const i = index++;
              const dim = visible !== null && !visible.has(c.case_id);
              return (
                <li key={c.case_id}>
                  <button
                    type="button"
                    onClick={() => onOpen(c.case_id)}
                    aria-label={`Case ${c.case_id}, ${FAMILY_LABEL[c.family]}. Open in the scenario inspector.`}
                    style={{ "--d": `${Math.min(i, 50) * 10}ms` } as CSSProperties}
                    className={`cell a-pop block w-full cursor-pointer ${dim ? "opacity-15" : "opacity-100"}`}
                  >
                    <canvas className="block aspect-[5/4] w-full" />
                    <span className="mono pointer-events-none absolute bottom-[3px] left-[5px] text-[8px] leading-none text-[#B7BDC7]">{c.case_id.replace("PICK-", "")}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
});
