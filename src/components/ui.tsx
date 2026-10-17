import type { CSSProperties, ReactNode } from "react";

export const WRAP = "mx-auto w-full max-w-[1560px] px-5 md:px-8";

/** A labelled figure. Mono and tabular, so a counter never reflows as it climbs. */
export function Stat({ label, value, sub, tone = "ink", delay = 0 }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ink" | "pass" | "fail" | "brand";
  delay?: number;
}) {
  const colour = { ink: "text-ink", pass: "text-pass", fail: "text-fail", brand: "text-brand" }[tone];
  return (
    <div className="a-rise min-w-0" style={{ "--d": `${delay}ms` } as CSSProperties}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">{label}</div>
      <div className={`mono mt-2 text-[26px] leading-none tracking-[-0.03em] ${colour}`}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] leading-tight text-muted">{sub}</div>}
    </div>
  );
}

/**
 * The hero counter: a settled count against a total, the done part in ink and the total greyed,
 * so the eye reads progress without needing a label.
 */
export function Counter({ done, total, caption }: { done: number; total: number; caption: string }) {
  return (
    <div className="shrink-0 text-left sm:text-right">
      <p className="mono text-[42px] leading-none tracking-[-0.045em] md:text-[56px]" aria-label={`${done} of ${total} ${caption}`}>
        <span className="font-semibold text-ink">{String(done).padStart(2, "0")}</span>
        <span className="text-[#C8CDD6]">/{total}</span>
      </p>
      <p className="mt-2 text-[12px] font-medium text-muted">{caption}</p>
    </div>
  );
}

export function Meter({ value, tone = "pass" }: { value: number; tone?: "pass" | "fail" | "brand" | "ink" }) {
  const fill = { pass: "bg-pass", fail: "bg-fail", brand: "bg-brand", ink: "bg-ink" }[tone];
  return (
    <span className="relative block h-1.5 overflow-hidden rounded-full bg-track">
      <span
        className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 motion-reduce:transition-none ${fill}`}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </span>
  );
}

export function Spinner({ className = "size-3.5" }: { className?: string }) {
  return <span aria-hidden className={`a-spin shrink-0 rounded-full border-2 border-brand/25 border-t-brand ${className}`} />;
}

/** A filled state glyph. Status is never colour alone, so every use pairs it with a word. */
export function Glyph({ state }: { state: "pass" | "fail" | "idle" }) {
  const tone = state === "pass" ? "bg-pass" : state === "fail" ? "bg-fail" : "bg-[#CDD2DA]";
  return (
    <span aria-hidden className={`grid size-[18px] shrink-0 place-items-center rounded-full text-[10px] font-bold leading-none text-white ${tone}`}>
      {state === "pass" ? "✓" : state === "fail" ? "✕" : "·"}
    </span>
  );
}

export function LiveDot() {
  return (
    <span aria-hidden className="relative grid size-2.5 shrink-0 place-items-center">
      <span className="a-ping absolute size-2.5 rounded-full bg-brand" />
      <span className="relative size-[7px] rounded-full bg-brand" />
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl border border-fail/25 bg-fail-soft px-4 py-3 text-sm text-fail">
      {children}
    </p>
  );
}
