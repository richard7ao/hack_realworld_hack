"use client";
import { useEffect, useState } from "react";
import { errorMessage, faultline, type SessionCredentials } from "@/lib/faultline";

type Advisory = {
  response_model: string; wall_elapsed_ms: number; evidence_ref?: string;
  scope: { case_id?: string; episode_id?: string };
  answers: { cause: { choice: string; confidence: number }; reobserve: { noul: number }; severity: { score: number } };
};
type Grounding = { response_model: string; wall_elapsed_ms: number; suggestions: { id: string; confidence: number; usable_suggestion: boolean }[] };
type Verification = { case_id?: string; triage?: { status: string; result?: Advisory }; grounding?: { status: string; result?: Grounding } };

export function JevPanel({ session, episodeId }: { session: SessionCredentials | null; episodeId?: string }) {
  const [saved, setSaved] = useState<Verification | null>(null);
  const [advisory, setAdvisory] = useState<Advisory | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { void faultline<Verification>("jev/evidence").then(setSaved).catch(() => {}); }, []);
  async function diagnose() {
    if (!session || !episodeId) return;
    setBusy(true); setError("");
    try { setAdvisory(await faultline<Advisory>("jev/triage", { session, body: { session_id: session.session_id, episode_id: episodeId } })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  const triage = advisory ?? saved?.triage?.result;
  const grounding = saved?.grounding?.result;
  return <section className="fl-section" aria-labelledby="fl-jev-title">
    <div className="fl-section-heading"><h2 id="fl-jev-title">Jev advisory</h2><p>Typed failure diagnosis and experimental image grounding. The independent evaluator keeps authority over every result.</p></div>
    <div className="fl-panel fl-pad">
      {triage ? <><p className="fl-caption">{advisory ? "New episode diagnosis" : "Saved API verification"} · {triage.response_model} · {triage.scope.case_id ?? saved?.case_id} · {(triage.wall_elapsed_ms / 1000).toFixed(2)} s measured request</p>
        <p><strong>{triage.answers.cause.choice.replaceAll("_", " ")}</strong> · {Math.round(triage.answers.cause.confidence * 100)}% diagnosis confidence</p>
        <p className="fl-caption">Re-observation probability: {triage.answers.reobserve.noul.toFixed(2)} · severity: {triage.answers.severity.score.toFixed(2)} / 3. This advice does not change the saved result, controller or release gate.</p></> : <p className="fl-caption">No completed Jev diagnosis is loaded.</p>}
      {grounding && <details><summary>Saved image grounding experiment · {grounding.response_model}</summary><p className="fl-caption">One approved tabletop crop · {(grounding.wall_elapsed_ms / 1000).toFixed(2)} s measured request. Suggestions require operator review; they have not replaced tracker estimates.</p><div className="fl-object-list">{grounding.suggestions.map((s) => <div key={s.id}><span><b>{s.id}</b><small>{Math.round(s.confidence * 100)}% confidence</small></span><span>{s.usable_suggestion ? "Suggestion available" : "Withheld · low confidence"}</span></div>)}</div></details>}
      <details><summary>Diagnose the current completed episode</summary><p className="fl-caption">This sends the selected episode’s structured observations and execution log to TypeSafe at api.typesafe.ai. It does not send camera images. The returned advice is saved separately.</p><button className="fl-button fl-button-secondary" disabled={!session || !episodeId || busy} onClick={() => void diagnose()}>{busy ? "Waiting for Jev…" : "Send this episode to Jev"}</button></details>
      {error && <p className="fl-error" role="alert">{error}</p>}
    </div>
  </section>;
}
