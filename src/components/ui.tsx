import type { CSSProperties, ReactNode } from "react";

export const WRAP = "mx-auto w-full max-w-[1480px] px-4 md:px-10";

/** A labelled figure. `hero` is for the one number a viewer should read first. */
export function Stat({ label, value, sub, tone = "ink", hero = false, delay = 0 }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ink" | "pass" | "fail" | "run";
  hero?: boolean;
  delay?: number;
}) {
  const colour = { ink: "text-ink", pass: "text-pass-ink", fail: "text-fail", run: "text-run" }[tone];
  return (
    <div className="fk-pop min-w-0" style={{ "--d": `${delay}ms` } as CSSProperties}>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className={`e-mono mt-1.5 tabular-nums leading-none tracking-[-0.04em] ${colour} ${hero ? "text-[40px] md:text-[52px]" : "text-[24px] md:text-[28px]"}`}>
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[12px] leading-tight text-muted">{sub}</div>}
    </div>
  );
}

/** A horizontal meter. Used for pass rates, where the label and the figure sit outside the bar. */
export function Meter({ value, tone = "pass", track = "bg-track" }: { value: number; tone?: "pass" | "fail" | "run" | "ink"; track?: string }) {
  const fill = { pass: "bg-pass", fail: "bg-fail", run: "bg-run", ink: "bg-ink" }[tone];
  return (
    <span className={`relative block h-1.5 overflow-hidden rounded-full ${track}`}>
      <span
        className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 motion-reduce:transition-none ${fill}`}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl border border-fail/30 bg-fail/5 px-4 py-3 text-sm text-fail">
      {children}
    </p>
  );
}

/** A pulsing dot, for "this is happening now". */
export function LiveDot({ tone = "run" }: { tone?: "run" | "pass" }) {
  const colour = tone === "run" ? "bg-run" : "bg-pass";
  return (
    <span aria-hidden className="relative grid size-2.5 flex-none place-items-center">
      <span className={`fk-ping absolute size-2.5 rounded-full ${colour}`} />
      <span className={`relative size-2 rounded-full ${colour}`} />
    </span>
  );
}
