"use client";
import { POLICY_NAMES, type CaseResult, type ControllerState, type PolicyManifest, type TraceEvent } from "@/lib/faultline";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function textField(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function numberField(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }

export function ControllerPanel({ selectedPolicyId, selectedPolicyAvailable, frontierAvailable, configurationLoaded, controller, events, episodeId, runMode, running, result }: {
  selectedPolicyId: string; selectedPolicyAvailable: boolean; frontierAvailable: boolean; configurationLoaded: boolean;
  controller?: ControllerState | null; events: TraceEvent[]; episodeId?: string;
  runMode?: string; running: boolean; result?: CaseResult | null;
}) {
  const currentEvents = episodeId ? events.filter((event) => event.episode_id === episodeId) : [];
  const loaded = episodeId && runMode !== "scenario_preview" ? controller : null;
  const manifestEvent = currentEvents.filter((event) => event.kind === "policy.manifest").at(-1);
  const eventManifest = record(manifestEvent?.data);
  const completed = result?.episode_id === episodeId ? result : null;
  const manifest = loaded?.manifest ?? completed?.policy ?? (typeof eventManifest?.policy_id === "string" ? eventManifest as PolicyManifest : null);
  const decision = currentEvents.filter((event) => event.kind === "policy.decision").at(-1);
  const action = record(decision?.data.action);
  const provider = record(decision?.data.provider_response);
  const responseModel = textField(provider?.response_model);
  const responseId = textField(provider?.response_id);
  const providerName = textField(provider?.provider);
  const assistance = record(provider?.jev_assistance);
  const guidanceAnswers = record(assistance?.answers);
  const cause = record(guidanceAnswers?.cause);
  const intent = record(guidanceAnswers?.recommended_intent);
  const risk = record(guidanceAnswers?.unsafe_to_repeat);
  const jevModel = textField(assistance?.response_model);
  const jevElapsed = numberField(assistance?.wall_elapsed_ms);
  const causeConfidence = numberField(cause?.confidence);
  const intentConfidence = numberField(intent?.confidence);
  const repeatRisk = numberField(risk?.noul);
  const callCounts = record(provider?.model_call_counts);
  const jevCalls = numberField(callCounts?.jev);
  const frontierCalls = numberField(callCounts?.frontier);
  const guidedSelected = selectedPolicyId.startsWith("jev_");
  const guidedLoaded = manifest?.policy_id.startsWith("jev_") ?? false;
  const actualCalls = loaded?.model_calls ?? completed?.model_calls;
  const actualInferenceMs = loaded?.inference_elapsed_ms ?? completed?.inference_elapsed_ms;
  const actualName = guidedLoaded && manifest ? POLICY_NAMES[manifest.policy_id] ?? manifest.model ?? manifest.policy_id : manifest?.model ?? (manifest ? POLICY_NAMES[manifest.policy_id] ?? manifest.policy_id : null);
  return <section className="fl-run-controls fl-controller-panel" aria-label="Actual controller evidence">
    <div className="fl-toolbar">
      <strong>{manifest ? `${running ? "Controlling" : "Executed controller"}: ${actualName}` : `Selected for next run: ${POLICY_NAMES[selectedPolicyId] ?? selectedPolicyId}`}</strong>
      {manifest && typeof actualCalls === "number" && <span className="fl-caption">{actualCalls} actual model calls</span>}
      {manifest && typeof actualInferenceMs === "number" && <span className="fl-caption">{(actualInferenceMs / 1000).toFixed(2)}s measured inference</span>}
      <a className="fl-text-link" href="#fl-jev-title">Jev diagnosis</a>
    </div>
    {!manifest && <p className="fl-caption">{!configurationLoaded ? "Waiting for backend policy availability." : selectedPolicyAvailable ? "Waiting for explicit execution. No controller is loaded for this preview." : "This selected policy is unavailable in the backend; choose an available adapter."} {configurationLoaded && selectedPolicyId.startsWith("scripted_") && !frontierAvailable && "The selected controller is scripted; GPT 6.1 Sol is unavailable until its backend key is configured."}</p>}
    {manifest && <p className="fl-caption">Actual policy ID: <code>{manifest.policy_id}</code> · version {manifest.version}{manifest.policy_id !== selectedPolicyId && ` · Next run selection: ${POLICY_NAMES[selectedPolicyId] ?? selectedPolicyId}`}{actualCalls === undefined && " · Model call counter not yet reported"}</p>}
    {action && <p className="fl-caption"><strong>Latest recorded decision:</strong> <code>{textField(action.type) ?? "typed action"}</code>{textField(action.target_id) && ` · ${textField(action.target_id)}`}{textField(action.reason) && ` · ${textField(action.reason)}`}</p>}
    {assistance ? <div aria-label="Recorded Jev manipulation feedback">
      <p className="fl-caption"><strong>Jev recovery feedback:</strong> {jevModel ?? "response model not reported"}{jevElapsed !== null && ` · ${(jevElapsed / 1000).toFixed(2)}s measured request`}{jevCalls !== null && ` · ${jevCalls} Jev calls`}{frontierCalls !== null && ` · ${frontierCalls} frontier calls`}</p>
      {textField(cause?.choice) && <p className="fl-caption">Cause: <code>{textField(cause?.choice)}</code>{causeConfidence !== null && ` · ${Math.round(causeConfidence * 100)}% reported confidence`}</p>}
      {textField(intent?.choice) && <p className="fl-caption">Recommended intent: <code>{textField(intent?.choice)}</code>{intentConfidence !== null && ` · ${Math.round(intentConfidence * 100)}% reported confidence`}{repeatRisk !== null && ` · unsafe-to-repeat score ${repeatRisk.toFixed(2)}`}</p>}
    </div> : (guidedSelected || guidedLoaded) && <p className="fl-caption">{guidedLoaded ? "The guided controller is loaded; no Jev feedback is recorded for the current decision yet." : "Jev feedback is selected for the next explicit run. No Jev response is recorded for this selection yet."}</p>}
    {provider && (responseModel || responseId || providerName) && <details><summary className="fl-caption">Provider evidence: {responseModel ?? "response model not reported"}{providerName ? ` · ${providerName}` : ""}</summary><p className="fl-caption">Response ID: <code>{responseId ?? "not reported"}</code>{textField(provider.requested_model) && ` · Requested model: ${textField(provider.requested_model)}`}</p></details>}
    <p className="fl-caption">Guided policies: the frontier model chooses motion; Jev supplies recovery advice. The independent evaluator determines results.</p>
  </section>;
}
