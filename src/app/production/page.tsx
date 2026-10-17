"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { World } from "@/components/faultline/World";
import { ControllerPanel } from "@/components/faultline/ControllerPanel";
import { Result, Trace } from "@/components/faultline/Trace";
import { errorMessage, faultline, POLICY_NAMES, type CaseResult, type ControllerState, type Health, type SimWorld, type SessionCredentials, type SessionState, type TraceEvent } from "@/lib/faultline";
import "../lab/lab.css";
import "./production.css";

type ProductionStage = { id: string; name: string; status: string; episode_id?: string | null; result?: CaseResult | null };
type ProductionChange = { id: string; change: "move_component" | "reroute_next"; stage_index: number; requested_at_ms: number; status: string; applied_at_ms?: number };
type ProductionJob = { job_id: string; session_id: string; status: string; policy_id: string; execution_backend?: "robosimstudio_cpu" | "kinematic"; current_stage_index?: number | null; stages: ProductionStage[]; events?: TraceEvent[]; changes?: ProductionChange[]; total_actions?: number; total_model_calls?: number; error?: string | null };
type SavedProductionEvidence = ProductionJob & { world?: SimWorld | null; result?: CaseResult | null; task?: { target_id: string } | null; controller?: ControllerState | null };
type ProductionSession = SessionState & { paused?: boolean; episode_id?: string; run_mode?: string; task?: { target_id: string } };
const SESSION_KEY = "faultline-production-session-v1";
const JOB_KEY = "faultline-production-job-v1";
const terminal = (status: string) => ["SUCCEEDED", "COMPLETED", "COMPLETE", "PASS", "FAILED", "STOPPED", "CANCELLED", "BLOCKED"].includes(status);

export default function ProductionLine() {
  const [session, setSession] = useState<SessionCredentials | null>(null);
  const sessionRef = useRef<SessionCredentials | null>(null);
  const [state, setState] = useState<ProductionSession | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [policyId, setPolicyId] = useState("scripted_reobserve");
  const manuallySelected = useRef(false);
  const [executionBackend, setExecutionBackend] = useState<"robosimstudio_cpu" | "kinematic">("kinematic");
  const backendManuallySelected = useRef(false);
  const [delay, setDelay] = useState("2.5");
  const [job, setJob] = useState<ProductionJob | null>(null);
  const [savedJobs, setSavedJobs] = useState<ProductionJob[]>([]);
  const [selectedSavedJob, setSelectedSavedJob] = useState("");
  const [recordedEvidence, setRecordedEvidence] = useState<SavedProductionEvidence | null>(null);
  const historyAutoLoaded = useRef(false);
  const [jobId, setJobId] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showTrace, setShowTrace] = useState(false);
  const remember = useCallback((credentials: SessionCredentials) => { sessionRef.current = credentials; setSession(credentials); sessionStorage.setItem(SESSION_KEY, JSON.stringify(credentials)); }, []);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) { const credentials = JSON.parse(saved) as SessionCredentials; if (credentials.expires_at_ms > Date.now()) { remember(credentials); setJobId(sessionStorage.getItem(JOB_KEY) ?? ""); } }
    } catch { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(JOB_KEY); }
  }, [remember]);
  const loadSavedEvidence = useCallback(async (id: string) => {
    const evidence = await faultline<SavedProductionEvidence>(`production/${encodeURIComponent(id)}/evidence`);
    setRecordedEvidence(evidence); setJob(evidence); setSelectedSavedJob(evidence.job_id);
    setExecutionBackend(evidence.execution_backend ?? (evidence.world?.robot.kinematics_kind === "robosim_physics" ? "robosimstudio_cpu" : "kinematic"));
    backendManuallySelected.current = true;
    setNotice("");
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      try {
        const result = await faultline<{ jobs: ProductionJob[] }>("production");
        if (cancelled) return;
        const completedJobs = result.jobs.filter((entry) => terminal(entry.status));
        setSavedJobs(completedJobs);
        if (!historyAutoLoaded.current) {
          historyAutoLoaded.current = true;
          if (!sessionRef.current && completedJobs[0]) await loadSavedEvidence(completedJobs[0].job_id);
        }
      } catch (err) { if (!cancelled) setError(errorMessage(err)); }
    }
    void loadHistory(); const timer = setInterval(() => void loadHistory(), 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [loadSavedEvidence]);
  useEffect(() => {
    let active = true;
    async function load() { try { const result = await faultline<Health>("health"); if (!active) return; setHealth(result); if (!backendManuallySelected.current) setExecutionBackend(result.robosim?.available ? "robosimstudio_cpu" : "kinematic"); if (!manuallySelected.current) { const best = result.policies.find((policy) => policy.available && policy.id === "jev_gpt-6.1-sol") ?? result.policies.find((policy) => policy.available && policy.id === "gpt-6.1-sol"); if (best) setPolicyId(best.id); } } catch (err) { if (active) setError(errorMessage(err)); } }
    void load(); const timer = setInterval(() => void load(), 10000); return () => { active = false; clearInterval(timer); };
  }, []);
  const refresh = useCallback(async () => {
    const credentials = sessionRef.current; if (!credentials) return;
    const next = await faultline<ProductionSession>(`sessions/${credentials.session_id}`, { session: credentials }); setState(next);
  }, []);
  useEffect(() => {
    if (!session) return; let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { const next = await faultline<ProductionSession>(`sessions/${session!.session_id}`, { session }); if (!cancelled) setState(next); } catch (err) { if (!cancelled) setError(errorMessage(err)); } if (!cancelled) timer = setTimeout(() => void poll(), 500); }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [session]);
  useEffect(() => {
    if (!jobId || !session || recordedEvidence) return; let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { const next = await faultline<ProductionJob>(`production/${encodeURIComponent(jobId)}`, { session }); if (!cancelled) { setJob(next); if (!terminal(next.status)) timer = setTimeout(() => void poll(), 700); } } catch (err) { if (!cancelled) { setError(errorMessage(err)); timer = setTimeout(() => void poll(), 2000); } } }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId, session, recordedEvidence]);
  async function act(label: string, operation: () => Promise<void>) { setPending(label); setError(""); setNotice(""); try { await operation(); } catch (err) { setError(errorMessage(err)); } finally { setPending(""); } }
  async function start() {
    let credentials = sessionRef.current;
    if (!credentials || credentials.expires_at_ms <= Date.now()) { credentials = await faultline<SessionCredentials>("camera/session", { method: "POST" }); remember(credentials); }
    const next = await faultline<ProductionJob>("production/start", { session: credentials, body: { session_id: credentials.session_id, policy_id: policyId, execution_backend: executionBackend, delay_seconds: Number(delay) } });
    setRecordedEvidence(null); setJob(next); setJobId(next.job_id); sessionStorage.setItem(JOB_KEY, next.job_id); await refresh();
  }
  async function change(change: "move_component" | "reroute_next") {
    if (!session || !job || recordedEvidence) return;
    const next = await faultline<ProductionJob>(`production/${encodeURIComponent(job.job_id)}/change`, { session, body: { session_id: session.session_id, change } });
    if (next?.job_id) setJob(next);
    setNotice(change === "move_component" ? "Operator component displacement queued for the next stage. Inspect its observations and policy actions for the response." : "Operator routing change submitted for the next stage. The changed destination will appear in its scene and evidence."); await refresh();
  }
  async function control(command: "pause" | "resume" | "stop") { if (!session || recordedEvidence) return; await faultline("policy/control", { session, body: { session_id: session.session_id, command } }); await refresh(); }
  const inspectedState = recordedEvidence ? {
    world: recordedEvidence.world ?? null, result: recordedEvidence.result ?? null,
    task: recordedEvidence.task ?? undefined,
    controller: recordedEvidence.controller ?? (recordedEvidence.result ? { manifest: recordedEvidence.result.policy, model_calls: recordedEvidence.result.model_calls, inference_elapsed_ms: recordedEvidence.result.inference_elapsed_ms } : null),
    events: recordedEvidence.events ?? [], episode_id: recordedEvidence.result?.episode_id,
    run_mode: "recorded_trace", running: false, paused: false,
  } : state;
  const inspectedBackend = job?.execution_backend ?? (inspectedState?.world?.robot.kinematics_kind === "robosim_physics" ? "robosimstudio_cpu" : recordedEvidence ? "kinematic" : executionBackend);
  const nativePhysics = inspectedBackend === "robosimstudio_cpu";
  const running = !recordedEvidence && !!job && !terminal(job.status);
  const busy = !!pending;
  const available = (id: string) => !!health?.policies.some((policy) => policy.id === id && policy.available);
  const completed = job?.stages.filter((stage) => !!stage.result).length ?? 0;
  const allVerified = !!job?.stages.length && job.stages.every((stage) => stage.result?.verified && stage.result.outcome === "PASS");
  const currentEpisode = inspectedState?.episode_id ?? inspectedState?.world?.episode_id;
  const events = recordedEvidence?.events ?? state?.events.filter((event) => (currentEpisode && event.episode_id === currentEpisode) || (event.kind.startsWith("production.") && event.data.job_id === jobId)) ?? [];
  const currentStage = job?.stages[job.current_stage_index ?? -1];
  const targetId = inspectedState?.task?.target_id ?? (recordedEvidence ? "" : state?.observed.objects[0]?.id) ?? "";
  return <div className="theme-e fl-lab fl-production">
    <header className="fl-header"><a href="/lab" className="fl-wordmark">FAULTLINE <span>Pick</span></a><nav aria-label="Product navigation"><a href="/lab">Workspace</a><a href="/robosim">RoboSim</a><a href="/production" aria-current="page">Production line</a><a href="/parallel">Parallel runs</a></nav><span className={`fl-status ${health ? "is-live" : "is-error"}`}>{health ? "ENGINE CONNECTED" : "ENGINE CONNECTING"}</span></header>
    <main className="fl-main">
      <div className="fl-title-row"><div><h1>{nativePhysics ? "Precision part transfer & rework" : "Electronics kitting & rework"}</h1><p>A four-stage production batch. Queue a component movement or change an order while the policy is working.</p></div><span className="fl-production-scope">{nativePhysics ? "Native contact physics · I2RT YAM" : "Six-joint kinematics · simulated manipulation"}</span></div>
      {error && <div className="fl-error fl-banner" role="alert">{error}<button className="fl-text-link" onClick={() => setError("")}>Dismiss</button></div>}
      {notice && <p className="fl-notice" role="status">{notice}</p>}
      <section className="fl-saved-benchmark-controls" aria-label="Saved production batches"><label className="fl-field">Saved batch<select value={selectedSavedJob} disabled={running || busy} onChange={(event) => setSelectedSavedJob(event.target.value)}><option value="">Choose recorded production evidence</option>{savedJobs.map((entry) => <option key={entry.job_id} value={entry.job_id}>{entry.job_id} · {POLICY_NAMES[entry.policy_id] ?? entry.policy_id} · {entry.stages.filter((stage) => stage.result?.outcome === "PASS").length}/{entry.stages.length} passing · {entry.status}</option>)}</select></label><button className="fl-button fl-button-secondary" disabled={!selectedSavedJob || running || busy} onClick={() => void act("history", () => loadSavedEvidence(selectedSavedJob))}>{pending === "history" ? "Loading evidence…" : "Load saved batch"}</button></section>
      {recordedEvidence && <p className="fl-notice" role="status">Saved batch evidence · no new execution. {POLICY_NAMES[recordedEvidence.policy_id] ?? recordedEvidence.policy_id} · {recordedEvidence.job_id}. The scene and policy logs below are recorded evidence; start another batch to execute again.</p>}
      <details className="fl-production-settings" open={!recordedEvidence || undefined}><summary>Configure a new production batch</summary><section className="fl-production-launch" aria-label="Production batch controls"><div><h2>{running ? "Batch in progress" : job ? "Batch execution evidence" : "Prepare the batch"}</h2><p>{running ? "Each stage executes a real policy episode and receives an independent evaluation." : nativePhysics ? "Four independent handling stages move one precision part between stations. The fixture is re-indexed to its declared pickup position, with the arm home, part upright and zero velocity between stages." : "Choose a policy. Start runs four sequential handling episodes. Object states carry forward; the arm returns home between stages."}</p></div><label className="fl-field">Execution environment<select value={executionBackend} disabled={running || busy} onChange={(event) => { backendManuallySelected.current = true; setExecutionBackend(event.target.value as "robosimstudio_cpu" | "kinematic"); }}><option value="robosimstudio_cpu" disabled={!health?.robosim?.available}>Contact physics · RoboSim / YAM{!health?.robosim?.available ? " · unavailable" : ""}</option><option value="kinematic">Kinematics · six-joint</option></select></label><label className="fl-field">Policy<select value={policyId} disabled={running || busy} onChange={(event) => { manuallySelected.current = true; setPolicyId(event.target.value); }}>{Object.entries(POLICY_NAMES).map(([id, name]) => <option key={id} value={id} disabled={!available(id)}>{name}{!available(id) ? " · unavailable" : ""}</option>)}</select></label><button className="fl-button fl-button-primary" disabled={running || busy || !available(policyId) || (executionBackend === "robosimstudio_cpu" && !health?.robosim?.available)} onClick={() => void act("start", start)}>{pending === "start" ? "Starting…" : job ? "Start another batch" : "Start production batch"}</button>{running && <div className="fl-toolbar"><button className="fl-button fl-button-secondary" disabled={busy || !state?.running} onClick={() => void act("control", () => control(state?.paused ? "resume" : "pause"))}>{state?.paused ? "Resume" : "Pause"}</button><button className="fl-text-link" disabled={busy} onClick={() => void act("stop", () => control("stop"))}>Stop</button></div>}</section></details>
      <div className="fl-production-grid"><section className="fl-panel fl-production-stage"><div className="fl-panel-heading"><h2>{currentStage?.name ?? "Production workcell"}</h2><span className="fl-status">{job?.status ?? "AWAITING START"}</span></div><World world={inspectedState?.world ?? null} targetId={targetId} source="procedural" provenance={{ run_mode: recordedEvidence ? "recorded_trace" : job ? "production_execution" : "awaiting_scene" }} cinematicDefault /><div className="fl-production-operator"><div><h3>Change the work while it runs</h3><p>Changes are queued for the next stage. The policy's response is recorded in its execution trace.</p></div><div className="fl-toolbar"><button className="fl-button fl-button-secondary" disabled={busy || !running} onClick={() => void act("move", () => change("move_component"))}>Move next component</button><button className="fl-button fl-button-secondary" disabled={busy || !running} onClick={() => void act("reroute", () => change("reroute_next"))}>Reroute next tray</button></div>{!![...(job?.changes ?? []), ...((job as ProductionJob & { pending_changes?: ProductionChange[] })?.pending_changes ?? [])].length && <ol className="fl-production-changes" aria-label="Operator changes">{[...(job?.changes ?? []), ...((job as ProductionJob & { pending_changes?: ProductionChange[] })?.pending_changes ?? [])].map((change) => <li key={change.id}><strong>{change.change === "move_component" ? "Move component" : "Reroute tray"}</strong><span>Stage {change.stage_index + 1} · {change.status === "APPLIED_BEFORE_STAGE_FREEZE" ? "Applied before stage execution" : "Queued for next stage"}</span><time dateTime={new Date(change.requested_at_ms).toISOString()}>{new Date(change.requested_at_ms).toLocaleTimeString()}</time></li>)}</ol>}<p className="fl-caption">{nativePhysics ? "Native simulation evaluates object contacts and fingertip grasps. Rework remains an operator-declared routing decision; this is simulated handling, not automated defect inspection." : "Rework is an operator-declared routing decision. Kinematics validates motion and collision proxies; it does not evaluate contact dynamics or inspect defects."}</p></div><details className="fl-controller-disclosure" open={inspectedState?.running || undefined}><summary>Policy actions & observations</summary><ControllerPanel selectedPolicyId={job?.policy_id ?? policyId} selectedPolicyAvailable={available(job?.policy_id ?? policyId)} frontierAvailable={available("gpt-6.1-sol")} configurationLoaded={!!health} controller={inspectedState?.controller} events={events} episodeId={currentEpisode} runMode={inspectedState?.run_mode} running={inspectedState?.running ?? false} result={inspectedState?.result} /></details></section>
      <aside className="fl-panel fl-production-queue"><div className="fl-panel-heading"><h2>Stage queue</h2><span className="fl-status">{job ? `${completed} / ${job.stages.length} evaluated` : "NOT STARTED"}</span></div>{job ? <><ol>{job.stages.map((stage, index) => <li key={stage.id ?? index} aria-current={stage === currentStage ? "step" : undefined}><div><span>{String(index + 1).padStart(2, "0")}</span><strong>{stage.name}</strong></div><p>{stage.status}</p>{stage.result && <details><summary>Independent evaluation · {stage.result.outcome}</summary><Result result={stage.result} /></details>}</li>)}</ol><div className="fl-production-batch-result"><strong>{allVerified ? "All stages verified · PASS" : terminal(job.status) ? "Batch finished · inspect stage outcomes" : "Evaluation in progress"}</strong><p>{allVerified ? "Every stage has a persisted, verified passing result." : `${completed} stage results received. A batch passes only when every stage has a verified passing result.`}</p>{typeof job.total_actions === "number" && <p>{job.total_actions} executed actions{typeof job.total_model_calls === "number" ? ` · ${job.total_model_calls} model calls` : ""}</p>}</div></> : <div className="fl-pad"><p className="fl-empty">Start a batch to load the declared electronics workcell and its four-stage queue. Stage status and results appear only from actual backend execution.</p></div>}</aside></div>
      <section className="fl-section"><div className="fl-production-evidence-heading"><div><h2>Execution evidence</h2><p>Operator changes, observations and actions are logged. Open an event to inspect the exact payload.</p></div><button className="fl-button fl-button-secondary" aria-expanded={showTrace} onClick={() => setShowTrace(!showTrace)}>{showTrace ? "Hide logs" : "Inspect logs"}</button></div>{showTrace && <div className="fl-panel"><Trace events={job?.events?.length ? job.events : events} /></div>}{job?.error && <p className="fl-error">{job.error}</p>}</section>
      <details className="fl-production-configuration"><summary>Execution configuration & scope</summary><label className="fl-field">Action pace<select value={delay} disabled={running || busy} onChange={(event) => setDelay(event.target.value)}><option value="1.5">1.5 seconds</option><option value="2.5">2.5 seconds</option><option value="3">3 seconds</option></select></label><p className="fl-caption">{nativePhysics ? "RoboSim native CPU physics uses the I2RT YAM robot, native contacts and fingertip grasp checks. One precision part moves through four independently evaluated stages. The fixture is re-indexed to its declared pickup position, with the arm home, part upright and zero velocity at each stage boundary." : "Declared component geometry, analytic six-joint kinematics and deterministic action validation. Object states carry between stages; the robot resets home at each stage boundary."} Policy inference and independent evaluator results come from actual episodes. No hardware robot is required.</p></details>
      <footer className="fl-footer"><strong>FAULTLINE Pick</strong><span>{nativePhysics ? "Native contact physics" : "Kinematic simulation"} · operator changes · independently evaluated stages</span><a href="/lab">Return to workspace</a></footer>
    </main>
  </div>;
}
