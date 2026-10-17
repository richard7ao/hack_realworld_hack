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

// ---------------------------------------------------------------------------------------------
// FAULTLINE status vocabulary. Status is never colour alone: every badge carries a word.
// ---------------------------------------------------------------------------------------------

export const OUTCOME_STYLE: Record<string, { label: string; chip: string; ink: string; dot: string }> = {
  PASS: { label: "Pass", chip: "bg-pass-soft text-pass", ink: "text-pass", dot: "bg-pass" },
  FAIL: { label: "Fail", chip: "bg-fail-soft text-fail", ink: "text-fail", dot: "bg-fail" },
  ESCALATED: { label: "Escalated", chip: "bg-warn-soft text-warn", ink: "text-warn", dot: "bg-warn" },
  TIMEOUT: { label: "Timeout", chip: "bg-warn-soft text-warn", ink: "text-warn", dot: "bg-warn" },
  UNKNOWN: { label: "Unknown", chip: "bg-track text-muted", ink: "text-muted", dot: "bg-faint" },
  running: { label: "Running", chip: "bg-brand-soft text-brand", ink: "text-brand", dot: "bg-brand" },
  pending: { label: "Pending", chip: "bg-track text-faint", ink: "text-faint", dot: "bg-line" },
};

export function OutcomeBadge({ outcome, reason }: { outcome: string; reason?: string | null }) {
  const s = OUTCOME_STYLE[outcome] ?? OUTCOME_STYLE.UNKNOWN!;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold ${s.chip}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
      {reason && <span className="mono text-[11px] font-medium opacity-80">{reason}</span>}
    </span>
  );
}

/**
 * Provenance, per the PRD: differently sourced trials are never presented as equally physical,
 * and demo data is never presented as an executed run.
 */
export function SourceBadge({ source }: { source: string }) {
  const demo = source === "demo_fixture";
  const label = { procedural_scripted: "Procedural, scripted policy", frontier_policy: "Procedural, frontier policy", live_capture: "Live physical capture", demo_fixture: "Demo data, not executed" }[source] ?? source;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.05em] ${demo ? "bg-warn-soft text-warn ring-1 ring-warn/30" : "bg-brand-soft text-brand"}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${demo ? "bg-warn" : "bg-brand"}`} />
      {label}
    </span>
  );
}

/** The four provenance layers the PRD asks the UI to keep visibly distinct. */
export function LayerTag({ layer }: { layer: "REAL CAMERA" | "ESTIMATED POSE" | "SIMULATED ACTION" | "TEST RESULT" }) {
  return <span className="mono rounded-md bg-[#F0F2F5] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] text-muted">{layer}</span>;
}
