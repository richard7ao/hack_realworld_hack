"use client";
import { useEffect, useRef, useState } from "react";
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
  const [diagnosis, setDiagnosis] = useState<{ episodeId: string; result: Advisory } | null>(null);
  const activeEpisode = useRef(episodeId);
  activeEpisode.current = episodeId;
  const advisory = diagnosis && diagnosis.episodeId === episodeId ? diagnosis.result : null;
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { void faultline<Verification>("jev/evidence").then(setSaved).catch(() => {}); }, []);
  useEffect(() => { setError(""); }, [episodeId]);
  async function diagnose() {
    if (!session || !episodeId) return;
    setBusy(true); setError("");
    try {
      const result = await faultline<Advisory>("jev/triage", { session, body: { session_id: session.session_id, episode_id: episodeId } });
      setDiagnosis({ episodeId, result });
    }
    catch (err) { if (activeEpisode.current === episodeId) setError(errorMessage(err)); } finally { setBusy(false); }
  }
  const triage = advisory;
  const grounding = saved?.grounding?.result;
  return <section className="fl-section" aria-labelledby="fl-jev-title">
    <div className="fl-section-heading"><h2 id="fl-jev-title">Post-run diagnosis</h2><p>Ask Jev to explain an episode after execution. This is separate from the pre-action assistance used by guided controllers.</p></div>
    <div className="fl-panel fl-pad">
      {triage ? <><p className="fl-caption">Episode diagnosis · {triage.response_model} · {triage.scope.case_id ?? "Case not reported"} · Episode {diagnosis?.episodeId} · {(triage.wall_elapsed_ms / 1000).toFixed(2)} s measured request</p>
        <p><strong>{triage.answers.cause.choice.replaceAll("_", " ")}</strong> · {Math.round(triage.answers.cause.confidence * 100)}% diagnosis confidence</p>
        <p className="fl-caption">Re-observation probability: {triage.answers.reobserve.noul.toFixed(2)} · severity: {triage.answers.severity.score.toFixed(2)} / 3. This advice does not change the saved result, controller or release gate.</p></> : <p className="fl-caption">No post-run diagnosis has been requested for this episode.</p>}
      {triage && <details><summary>Full diagnosis response and provenance</summary><pre>{JSON.stringify(triage, null, 2)}</pre></details>}
      {saved?.triage?.result && <details><summary>Saved API verification · separate recorded evidence</summary><p className="fl-caption">Case {saved.triage.result.scope.case_id ?? saved.case_id ?? "not reported"} · {saved.triage.result.response_model}. This is saved verification, not a diagnosis of the currently inspected episode.</p><details><summary>Full saved response</summary><pre>{JSON.stringify(saved.triage.result, null, 2)}</pre></details></details>}
      {grounding && <details><summary>Saved image grounding experiment · {grounding.response_model}</summary><p className="fl-caption">One approved tabletop crop · {(grounding.wall_elapsed_ms / 1000).toFixed(2)} s measured request. Suggestions require operator review; they have not replaced tracker estimates.</p><div className="fl-object-list">{grounding.suggestions.map((s) => <div key={s.id}><span><b>{s.id}</b><small>{Math.round(s.confidence * 100)}% confidence</small></span><span>{s.usable_suggestion ? "Suggestion available" : "Withheld · low confidence"}</span></div>)}</div><details><summary>Full grounding response</summary><pre>{JSON.stringify(grounding, null, 2)}</pre></details></details>}
      <details><summary>Request episode diagnosis</summary><p className="fl-caption">This sends the selected episode’s structured observations and execution log to TypeSafe at api.typesafe.ai. It does not send camera images. The returned advice is saved separately.</p><button className="fl-button fl-button-secondary" disabled={!session || !episodeId || busy} onClick={() => void diagnose()}>{busy ? "Waiting for Jev…" : "Request Jev diagnosis"}</button></details>
      {error && <p className="fl-error" role="alert">{error}</p>}
    </div>
  </section>;
}
