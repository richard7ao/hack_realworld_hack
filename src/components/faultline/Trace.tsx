"use client";
import { useState } from "react";
import type { CaseResult, TraceEvent } from "@/lib/faultline";
export function Result({ result }: { result: CaseResult }) {
  return <div className={`fl-result ${result.outcome === "PASS" ? "is-pass" : "is-fail"}`}>
    <div className="fl-result-line"><strong>{result.outcome}</strong><span>{result.verified ? "Independently evaluated" : "Not verified"}</span></div>
    <code>{result.reason}</code>
    <dl className="fl-mini-stats"><div><dt>Actions</dt><dd>{result.actions}</dd></div><div><dt>Model calls</dt><dd>{result.model_calls}</dd></div><div><dt>Inference</dt><dd>{(result.inference_elapsed_ms / 1000).toFixed(2)}s</dd></div><div><dt>Simulation</dt><dd>{(result.sim_elapsed_ms / 1000).toFixed(2)}s</dd></div></dl>
    <small>Episode {result.episode_id} · {result.policy.policy_id} · {result.policy.version}</small>
  </div>;
}
function summary(e: TraceEvent): string {
  const data = e.data;
  if (data.action && typeof data.action === "object") {
    const action = data.action as { type?: string; target_id?: string; reason?: string };
    const result = data.result as { reason?: string } | undefined;
    return [action.type, action.target_id, result?.reason ?? action.reason].filter(Boolean).join(" · ");
  }
  if (data.disturbance && typeof data.disturbance === "object") {
    const d = data.disturbance as { type?: string; source?: string; object_id?: string };
    return [d.type, d.object_id, d.source].filter(Boolean).join(" · ");
  }
  if (typeof data.error === "string") return data.error;
  if (typeof data.reason === "string") return data.reason;
  const provider = data.provider_response as { response_model?: string; provider?: string } | undefined;
  if (provider) return [provider.response_model, provider.provider].filter(Boolean).join(" · ");
  if (typeof data.outcome === "string") return data.outcome;
  return "Recorded execution evidence";
}
export function Trace({ events, compact = false }: { events: TraceEvent[]; compact?: boolean }) {
  const [showTelemetry, setShowTelemetry] = useState(false);
  const telemetry = ["camera.frame_meta", "observed.scene", "sim.state", "policy.observation"];
  const relevant = events.filter((e) => showTelemetry || !telemetry.includes(e.kind));
  const hidden = events.length - relevant.length;
  const labels: Record<string, string> = { "policy.decision": "Controller decision", "policy.error": "Controller request failed", "policy.timeout": "Controller request timed out", "policy.manifest": "Controller loaded", "episode.finished": "Episode evaluated", "episode.stopped": "Episode stopped", "action.result": "Action result", "disturbance.applied": "Disturbance applied" };
  return <div className={`fl-trace ${compact ? "fl-trace-compact" : ""}`}>
    {!!events.length && <div className="fl-toolbar"><span className="fl-caption">Newest event first · {relevant.length} shown{hidden > 0 ? ` · ${hidden} observation / state events hidden` : ""}</span><label className="fl-caption"><input type="checkbox" checked={showTelemetry} onChange={(event) => setShowTelemetry(event.target.checked)} /> Include observations and state</label></div>}
    {!relevant.length && <p className="fl-empty">Execution events will appear here. Nothing has run yet.</p>}
    {[...relevant].reverse().map((e, i) => <details key={`${e.episode_id}-${e.seq}-${i}`} className={e.kind.includes("error") || (e.data.result as { status?: string } | undefined)?.status === "rejected" ? "fl-event-error" : ""}>
      <summary><span className="fl-event-index">{e.seq ?? "—"}</span><span><b>{labels[e.kind] ?? e.kind.replaceAll(".", " · ").replaceAll("_", " ")}</b>{summary(e) && <small>{summary(e)}</small>}</span><time>{typeof e.sim_elapsed_ms === "number" ? `${(e.sim_elapsed_ms / 1000).toFixed(1)}s` : ""}</time></summary>
      <p className="fl-caption"><code>{e.kind}</code> · Episode <code>{e.episode_id ?? "not reported"}</code>{typeof e.timestamp_ms === "number" && ` · Recorded timestamp ${e.timestamp_ms} ms`}</p>
      <details><summary className="fl-caption">Full event payload · requests, responses and provenance</summary><pre>{JSON.stringify(e.data, null, 2)}</pre></details>
    </details>)}
  </div>;
}
