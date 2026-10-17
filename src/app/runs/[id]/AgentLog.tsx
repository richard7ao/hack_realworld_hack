"use client";
import type { Run } from "../../../lib/contract";
import type { Tally } from "../../../lib/score";
import { Glyph, Spinner } from "../../../components/ui";

type Entry = { text: string; done: boolean; active: boolean };

/**
 * What the harness has actually done, in order. The reference product earns a lot of its
 * credibility from this panel: it turns a progress bar into a narrative, and it is the thing a
 * viewer reads while waiting.
 */
function entries(t: Tally, run: Run): Entry[] {
  const started = t.settled + t.inFlight > 0;
  const anySettled = t.settled > 0;
  const allSettled = t.settled >= run.fanout;
  return [
    { text: `Provisioned ${run.concurrency} GPU workers`, done: started, active: !started },
    { text: `Loaded ${run.environmentName} and randomised ${run.fanout} variants`, done: started, active: false },
    { text: anySettled ? `Ran ${t.settled} of ${run.fanout} rollouts` : "Booting simulator instances", done: allSettled, active: started && !allSettled },
    { text: "Scored episodes and evaluated the gate", done: allSettled, active: false },
  ];
}

export function AgentLog({ run, tally }: { run: Run; tally: Tally }) {
  return (
    <section aria-label="Agent log" className="card p-4">
      <h2 className="label">Agent log</h2>
      <ul className="mt-3.5 flex flex-col gap-3">
        {entries(tally, run).map((e) => (
          <li key={e.text} className={`flex items-start gap-2.5 text-[13px] leading-snug ${e.done || e.active ? "text-ink-2" : "text-faint"}`}>
            {e.active ? <Spinner className="mt-0.5 size-[18px]" /> : <span className="mt-0.5"><Glyph state={e.done ? "pass" : "idle"} /></span>}
            <span className="min-w-0">{e.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
