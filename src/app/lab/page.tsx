"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera } from "@/components/faultline/Camera";
import { ControllerPanel } from "@/components/faultline/ControllerPanel";
import { ObjectAssets } from "@/components/faultline/ObjectAssets";
import type { ObjectAssetJob } from "@/components/faultline/world-view";
import { World } from "@/components/faultline/World";
import { Result, Trace } from "@/components/faultline/Trace";
import { Recorder } from "@/components/faultline/Recorder";
import { JevPanel } from "@/components/faultline/JevPanel";
import { POLICY_NAMES, SOURCE_NAMES, errorMessage, faultline, type Benchmark, type Disturbance, type Episode, type Health, type Scenario, type SessionCredentials, type SessionState, type SimWorld } from "@/lib/faultline";
import "./lab.css";

type LiveState = SessionState & { paused?: boolean; episode_id?: string; scenario_source?: string; run_mode?: string };
const STORAGE_KEY = "faultline-camera-session-v1";
function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function LiveLab() {
  const [session, setSession] = useState<SessionCredentials | null>(null);
  const sessionRef = useRef<SessionCredentials | null>(null);
  const creating = useRef<Promise<SessionCredentials> | null>(null);
  const [state, setState] = useState<LiveState | null>(null);
  const [viewMode, setViewMode] = useState<"camera" | "warehouse" | "physics">("camera");
  const [cameraRobotId, setCameraRobotId] = useState("cartesian");
  const [warehouseRobotId, setWarehouseRobotId] = useState("industrial_6r");
  const [focusStage, setFocusStage] = useState(false);
  const [area, setArea] = useState<"workspace" | "regressions" | "release">("workspace");
  const [showEvidence, setShowEvidence] = useState(false);
  const [objectAssets, setObjectAssets] = useState<ObjectAssetJob[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [pending, setPending] = useState("");
  const [targetId, setTargetId] = useState(""); const [policyId, setPolicyId] = useState("scripted_open_loop");
  const policyDefaultApplied = useRef(false);
  const environmentLinkApplied = useRef(false);
  const policyManuallySelected = useRef(false);
  const [pace, setPace] = useState("1.5"); const [caseName, setCaseName] = useState("Tabletop target displacement");
  const [confirmed, setConfirmed] = useState(false);
  const [scenarios, setScenarios] = useState<Scenario[]>([]); const [selectedCase, setSelectedCase] = useState("");
  const [baseline, setBaseline] = useState("scripted_open_loop"); const [candidate, setCandidate] = useState("scripted_reobserve");
  const [suite, setSuite] = useState("saved"); const [minimum, setMinimum] = useState("3");
  const [executionBackend, setExecutionBackend] = useState<"local" | "modal_cpu">("local");
  const [concurrency, setConcurrency] = useState(2);
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [savedBenchmarks, setSavedBenchmarks] = useState<Benchmark[]>([]);
  const [selectedBenchmarkId, setSelectedBenchmarkId] = useState("");
  const [playback, setPlayback] = useState<Episode | null>(null); const [playbackIndex, setPlaybackIndex] = useState(0); const [playing, setPlaying] = useState(false);

  const remember = useCallback((credentials: SessionCredentials | null) => {
    sessionRef.current = credentials; setSession(credentials);
    if (credentials) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials)); else sessionStorage.removeItem(STORAGE_KEY);
  }, []);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) { const value = JSON.parse(stored) as SessionCredentials; if (value.expires_at_ms > Date.now() && value.token) remember(value); else sessionStorage.removeItem(STORAGE_KEY); }
    } catch { sessionStorage.removeItem(STORAGE_KEY); }
  }, [remember]);
  const ensureSession = useCallback(async () => {
    if (sessionRef.current && sessionRef.current.expires_at_ms > Date.now()) {
      try {
        await faultline(`sessions/${sessionRef.current.session_id}`, { session: sessionRef.current });
        return sessionRef.current;
      } catch (err) {
        if (!errorMessage(err).includes("Invalid or expired")) throw err;
        remember(null); setState(null);
      }
    }
    if (creating.current) return creating.current;
    creating.current = faultline<SessionCredentials>("camera/session", { method: "POST" }).then((credentials) => { remember(credentials); return credentials; }).finally(() => { creating.current = null; });
    return creating.current;
  }, [remember]);
  const refresh = useCallback(async () => {
    const credentials = sessionRef.current; if (!credentials) return;
    const next = await faultline<LiveState>(`sessions/${credentials.session_id}`, { session: credentials });
    setState(next);
  }, []);
  const loadScenarios = useCallback(async () => {
    const data = await faultline<{ scenarios: Scenario[] }>("scenarios"); setScenarios(data.scenarios);
  }, []);
  useEffect(() => {
    let active = true;
    async function status() {
      try {
        const [nextHealth, saved] = await Promise.all([faultline<Health>("health"), faultline<{ scenarios: Scenario[] }>("scenarios")]);
        if (active) { setHealth(nextHealth); setScenarios(saved.scenarios); }
      } catch (err) { if (active) { setHealth(null); setError(errorMessage(err)); } }
    }
    void status(); const timer = setInterval(() => void status(), 10_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!health || policyDefaultApplied.current) return;
    policyDefaultApplied.current = true;
    if (!policyManuallySelected.current) {
      if (health.policies.some((policy) => policy.id === "jev_gpt-6.1-sol" && policy.available)) setPolicyId("jev_gpt-6.1-sol");
      else if (health.policies.some((policy) => policy.id === "gpt-6.1-sol" && policy.available)) setPolicyId("gpt-6.1-sol");
    }
  }, [health]);
  useEffect(() => {
    if (!health || environmentLinkApplied.current) return;
    const requested = new URL(window.location.href).searchParams.get("environment");
    if (requested !== "physics" && requested !== "warehouse") return;
    environmentLinkApplied.current = true;
    if (requested === "physics") void action("Loading RoboSim physics", loadRoboSim);
    else void action("Loading warehouse", loadWarehouse);
  }, [health]);
  const choosePolicy = (value: string) => { policyManuallySelected.current = true; setPolicyId(value); };
  const loadBenchmarks = useCallback(async () => {
    const saved = await faultline<{ benchmarks: Benchmark[] }>("benchmarks");
    setSavedBenchmarks(saved.benchmarks);
    setSelectedBenchmarkId((current) => current || saved.benchmarks[0]?.id || "");
  }, []);
  useEffect(() => {
    void loadBenchmarks().catch(() => {});
    const timer = setInterval(() => void loadBenchmarks().catch(() => {}), 15_000);
    return () => clearInterval(timer);
  }, [loadBenchmarks]);
  useEffect(() => {
    if (!session) return; let active = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await faultline<LiveState>(`sessions/${session!.session_id}`, { session });
        if (active) { setState(next); if (next.error) setError(next.error); }
      } catch (err) {
        if (active) {
          const message = errorMessage(err); setError(message);
          if (message.includes("Invalid or expired")) { remember(null); setState(null); }
        }
      }
      if (active) timer = setTimeout(() => void poll(), 300);
    }
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [session, remember]);
  useEffect(() => { if (!targetId && state?.observed.objects[0]) setTargetId(state.observed.objects[0].id); }, [targetId, state?.observed.objects]);
  useEffect(() => { setConfirmed(false); }, [state?.episode_id, state?.world?.episode_id]);
  useEffect(() => {
    if (state?.world?.robot.kinematics_kind === "robosim_physics") setViewMode("physics");
    else if (state?.run_mode === "scenario_preview" || (state?.run_mode === "scenario_rerun" && state.scenario_source === "procedural")) setViewMode("warehouse");
    if (state?.case_id && ["scenario_preview", "scenario_rerun"].includes(state.run_mode ?? "")) setSelectedCase(state.case_id);
  }, [state?.run_mode, state?.case_id, state?.scenario_source, state?.world?.robot.kinematics_kind]);
  useEffect(() => {
    if (state?.observed.coordinate_frame !== "workcell_m") setCameraRobotId("cartesian");
  }, [state?.observed.coordinate_frame]);
  useEffect(() => {
    if (!benchmark || benchmark.status !== "RUNNING") return; let active = true; let timer: ReturnType<typeof setTimeout>;
    const id = benchmark.id;
    async function poll() {
      try { const next = await faultline<Benchmark>(`benchmarks/${id}`); if (active) setBenchmark(next); }
      catch (err) { if (active) setError(errorMessage(err)); }
      if (active) timer = setTimeout(() => void poll(), 600);
    }
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [benchmark?.id, benchmark?.status]);

  async function action(name: string, work: () => Promise<unknown>) {
    setPending(name); setError(""); setNotice("");
    try { await work(); } catch (err) { setError(errorMessage(err)); } finally { setPending(""); }
  }
  async function startLive() {
    const credentials = await ensureSession();
    await faultline("policy/run", { session: credentials, body: { session_id: credentials.session_id, policy_id: policyId, target_id: targetId, robot_id: cameraRobotId, delay_seconds: Number(pace) } });
    setNotice("Live execution started. Move the real target after the first approach begins."); await refresh();
  }
  async function loadWarehouse() {
    const credentials = await ensureSession();
    const response = await faultline<{ scenarios: Scenario[]; preview_case_id: string }>("workcells/warehouse", {
      session: credentials, body: { session_id: credentials.session_id, count: 4, seed: 42017, robot_id: warehouseRobotId },
    });
    setViewMode("warehouse"); setSelectedCase(response.preview_case_id);
    const preview = response.scenarios.find((saved) => saved.case_id === response.preview_case_id);
    if (preview) setTargetId(preview.task.target_id);
    await loadScenarios(); await refresh();
    setNotice(`Loaded warehouse geometry and saved ${response.scenarios.length} reproducible scenario definitions. No policy execution has started.`);
  }
  async function loadRoboSim() {
    const credentials = await ensureSession();
    const response = await faultline<{ scenarios: Scenario[]; preview_case_id: string; executed: false }>("workcells/robosim", {
      session: credentials, body: { session_id: credentials.session_id, count: 2, seed: 42017 },
    });
    setViewMode("physics"); setSelectedCase(response.preview_case_id);
    const preview = response.scenarios.find((saved) => saved.case_id === response.preview_case_id);
    if (preview) setTargetId(preview.task.target_id);
    await loadScenarios(); await refresh();
    setNotice(`Loaded ${response.scenarios.length} native-physics scenario definitions. Ready for execution; no policy episode has run.`);
  }
  async function loadScenarioPreview(caseId: string) {
    if (!caseId) return;
    const credentials = await ensureSession();
    const response = await faultline<{ scenario: Scenario; executed: false }>("workcells/scenario", {
      session: credentials, body: { session_id: credentials.session_id, case_id: caseId },
    });
    setViewMode(response.scenario.provenance.execution_backend === "robosimstudio_cpu" ? "physics" : "warehouse"); setSelectedCase(response.scenario.case_id); setTargetId(response.scenario.task.target_id);
    await refresh();
    setNotice(`Loaded ${response.scenario.name}. Its saved geometry, robot and disturbances are unchanged; no inference has run.`);
  }
  async function switchToCamera() {
    if (sessionRef.current) await faultline("workcells/camera", { session: sessionRef.current, body: { session_id: sessionRef.current.session_id } });
    setViewMode("camera"); setTargetId(state?.observed.objects[0]?.id ?? ""); await refresh();
    setNotice("Camera workcell selected. Tracking and calibration are retained; choose a real target before starting.");
  }
  async function startWarehouse() {
    const credentials = await ensureSession();
    const stagedCaseId = state?.case_id;
    if (!stagedCaseId) throw new Error("Load an environment or select a saved scenario first.");
    await faultline(`replays/${stagedCaseId}/rerun`, { session: credentials, body: { session_id: credentials.session_id, policy_id: policyId, delay_seconds: Number(pace) } });
    setNotice("Fresh scenario execution started using its saved execution backend, robot, geometry, seed and disturbance schedule."); await refresh();
  }
  async function control(command: "pause" | "resume" | "stop") {
    if (!session) return;
    await faultline("policy/control", { session, body: { session_id: session.session_id, command } }); await refresh();
  }
  async function compile() {
    if (!session) return;
    const saved = await faultline<{ scenario: Scenario; scenario_hash: string }>("scenarios/from-live", { session, body: { session_id: session.session_id, name: caseName, confirmed } });
    setSelectedCase(saved.scenario.case_id); setArea("regressions"); setNotice(`Saved immutable scenario ${saved.scenario.case_id}. Run a fresh comparison below.`); await loadScenarios();
  }
  async function rerun() {
    const credentials = await ensureSession();
    await faultline(`replays/${selectedCase}/rerun`, { session: credentials, body: { session_id: credentials.session_id, policy_id: candidate, delay_seconds: Number(pace) } });
    choosePolicy(candidate);
    setViewMode(scenario?.provenance.execution_backend === "robosimstudio_cpu" ? "physics" : scenario?.source === "procedural" ? "warehouse" : "camera");
    setArea("workspace"); setShowEvidence(true); setNotice("Fresh scenario execution started. Camera updates do not alter this replay environment."); await refresh();
  }
  async function runBenchmark() {
    if (executionBlockedReason) throw new Error(executionBlockedReason);
    if (baseline === candidate) throw new Error("Choose different baseline and candidate policies for a comparison.");
    const credentials = await ensureSession();
    const next = await faultline<Benchmark>("benchmarks/run", { session: credentials, body: { session_id: credentials.session_id, case_ids: suite === "saved" ? [selectedCase] : [], generated_count: suite === "saved" || suite === "warehouse12" ? 0 : Number(suite), ...(suite === "warehouse12" ? { warehouse_count: 12 } : {}), baseline, candidate, execution_backend: executionBackend, concurrency, gate: { minimum_cases: Number(minimum), completion_threshold: .8 } } });
    setBenchmark(next); setSelectedBenchmarkId(next.id); void loadBenchmarks().catch(() => {}); setNotice("Paired executions started. Counts advance only when an actual result is persisted.");
  }
  async function loadSavedBenchmark() {
    if (!selectedBenchmarkId) return;
    const saved = await faultline<Benchmark>(`benchmarks/${selectedBenchmarkId}`);
    setBenchmark(saved); setBaseline(saved.baseline_policy); setCandidate(saved.candidate_policy);
    setExecutionBackend(saved.execution_backend === "modal_cpu" ? "modal_cpu" : "local");
    setConcurrency(saved.concurrency ?? 2);
    if (saved.gate) setMinimum(String(saved.gate.config.minimum_cases));
    setNotice(`Loaded persisted benchmark ${saved.id}. Displaying its actual completed results and original policy manifests.`);
  }
  async function loadEpisode(episodeId: string) {
    const episode = await faultline<Episode>(`episodes/${episodeId}`); setPlayback(episode); setPlaybackIndex(0); setPlaying(false);
    setTimeout(() => document.getElementById("playback")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    setNotice("Recorded trace opened below. These are saved states; execute a fresh rerun to evaluate a policy.");
  }
  async function inject() {
    if (!session || !state?.world) return;
    if (!state.running || !["live_capture", "operator_injected"].includes(state.run_mode ?? "")) throw new Error("Virtual injection is available only during live capture. Saved-case reruns remain isolated.");
    const target = state.world.objects.find((o) => o.id === targetId); if (!target) throw new Error("Select a target object first.");
    const width = state.world.workspace[0]; const depth = state.world.workspace[1];
    const x = target.position[0] < width * .5 ? width * .68 : width * .28;
    const y = target.position[1] < depth * .5 ? depth * .55 : depth * .3;
    await faultline("disturbances/inject", { session, body: { session_id: session.session_id, disturbance: { type: "MOVE_OBJECT", after_action_index: state.world.step, object_id: targetId, position: [x, y, target.position[2]], source: "operator_injected" } } });
    setNotice("Operator disturbance injected into simulator. This is labelled separately from physical camera movement.");
  }
  const currentEpisode = state?.episode_id ?? state?.world?.episode_id;
  // The session bus spans episodes. Keep this panel scoped to its current execution;
  // a compiled-case lifecycle event belongs here only when its provenance matches.
  const liveTraceEvents = state?.events.filter((event) => {
    if (!currentEpisode) return false;
    if (event.episode_id === currentEpisode) return true;
    return !event.episode_id && event.kind === "scenario.created" && scenarios.some((saved) =>
      saved.case_id === event.data.case_id && saved.provenance.capture_episode_id === currentEpisode);
  }) ?? [];
  const disturbances = state?.live_disturbances ?? (state?.events.filter((e) => e.kind === "disturbance.detected" && (!currentEpisode || e.episode_id === currentEpisode)).map((e) => e.data.disturbance as Disturbance) ?? []);
  const scenario = scenarios.find((s) => s.case_id === selectedCase);
  const environmentDefinition = health?.environments?.find((environment) => environment.id === viewMode);
  const executionOption = health?.execution_backends?.find((option) => option.id === executionBackend);
  const selectedEnvironment = suite !== "saved" ? "warehouse" : scenario?.provenance.execution_backend === "robosimstudio_cpu" ? "physics" : scenario?.source === "captured_live_rgb" || scenario?.source === "operator_defined" ? "camera" : "warehouse";
  const executionBlockedReason = executionOption && !executionOption.available ? executionOption.reason || "This execution backend is unavailable." : executionBackend === "modal_cpu" && !executionOption ? "Modal CPU availability has not been reported by the engine." : executionOption && (!executionOption.supported_policies.includes(baseline) || !executionOption.supported_policies.includes(candidate)) ? "This backend does not support the selected policies. Choose supported scripted policies or use Local." : executionOption && !executionOption.supported_environments.includes(selectedEnvironment) ? "This backend does not support this scenario environment. Use Local for camera captures and native physics." : executionBackend === "modal_cpu" && (scenario?.source !== "procedural" && suite === "saved" || selectedEnvironment !== "warehouse") ? "Modal CPU executes procedural kinematics. Use Local for captured scenes and native physics." : "";
  const manifestView = state?.run_mode === "scenario_preview" || state?.run_mode === "scenario_rerun";
  const stageScenario = scenarios.find((saved) => saved.case_id === state?.case_id) ?? (manifestView ? scenario : undefined);
  const stageTargetId = manifestView ? state?.task?.target_id ?? stageScenario?.task.target_id ?? targetId : targetId;
  const robotId = viewMode === "warehouse" ? warehouseRobotId : cameraRobotId;
  const robots = health?.robots ?? [];
  const robotDescriptor = robots.find((robot) => robot.id === robotId);
  const physicsScenarios = scenarios.filter((saved) => saved.provenance.execution_backend === "robosimstudio_cpu" && !saved.case_id.includes("-fall-proof-"));
  const warehouseScenarios = scenarios.filter((saved) => saved.provenance.execution_backend !== "robosimstudio_cpu" && saved.source === "procedural" && (saved.family.startsWith("warehouse_") || saved.case_id.startsWith("WAREHOUSE-") || !!saved.provenance.warehouse));
  const stageObjects = viewMode !== "camera" ? stageScenario?.initial_scene.objects ?? state?.world?.objects ?? [] : state?.observed.objects ?? [];
  const policies = health?.policies ?? [];
  const policyAvailable = (id: string) => policies.some((p) => p.id === id && p.available);
  const worlds = playback?.events.filter((e) => e.kind === "sim.state").map((e) => e.data as unknown as SimWorld) ?? [];
  useEffect(() => {
    if (!playing || !worlds.length) return;
    const timer = setInterval(() => setPlaybackIndex((i) => { if (i + 1 >= worlds.length) { setPlaying(false); return i; } return i + 1; }), 700);
    return () => clearInterval(timer);
  }, [playing, worlds.length]);
  useEffect(() => { if (state?.running || state?.result) setShowEvidence(true); }, [state?.running, state?.result?.episode_id]);
  const busy = !!pending;
  const liveCapture = state?.scenario_source ? state.scenario_source === "captured_live_rgb" && state.run_mode !== "scenario_rerun" : state?.result?.source === "captured_live_rgb";

  function policySelect(value: string, onChange: (value: string) => void, id: string) {
    return <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>{Object.entries(POLICY_NAMES).map(([key, name]) => <option key={key} value={key} disabled={!policyAvailable(key)}>{name}{!policyAvailable(key) ? (key.startsWith("scripted_") ? " · engine unavailable" : " · key unavailable") : ""}</option>)}</select>;
  }
  return <div className={`theme-e fl-lab ${focusStage && area === "workspace" ? "is-focus-mode" : ""}`}>
    <header className="fl-header"><a href="/" className="fl-wordmark" aria-label="FAULTLINE home"><svg width="26" height="30" viewBox="0 0 26 30" fill="none" aria-hidden><path d="M3 3h20v24H3z" stroke="currentColor" strokeWidth="2" /><path d="m17 3-7 11 7 3-7 10" stroke="currentColor" strokeWidth="2" /></svg>FAULTLINE <span>Pick</span></a><nav aria-label="Product navigation">{([["workspace", "Workspace"], ["regressions", "Regression tests"], ["release", "Release checks"]] as const).map(([id, label]) => <button key={id} type="button" aria-current={area === id ? "page" : undefined} onClick={() => { setArea(id); setNotice(""); }}>{label}</button>)}<a href="/robosim">RoboSim</a><a href="/production">Production line</a><a href="/parallel">Parallel runs</a></nav><span className={`fl-status ${health ? "is-live" : "is-error"}`}>{health ? "LOCAL ENGINE CONNECTED" : "ENGINE OFFLINE"}</span></header>
    <main className="fl-main">
      <div className="fl-title-row"><div><h1>{area === "workspace" ? "Policy workspace" : area === "regressions" ? "Regression tests" : "Release checks"}</h1><p>{area === "workspace" ? "Choose an environment, run a policy, and turn what happens into a regression test." : area === "regressions" ? "Save real disturbances, inspect versioned scenarios, and execute them against a new policy." : "Compare baseline and candidate on identical scenarios. Every release verdict links to execution evidence."}</p></div><Recorder /></div>
      {error && <div className="fl-error fl-banner" role="alert"><strong>Action needs attention.</strong> {error}<button className="fl-text-link" onClick={() => setError("")}>Dismiss</button></div>}
      {pending && <div className="fl-notice fl-pending" role="status" aria-live="polite">{pending === "Loading RoboSim physics" || pending === "Loading scenario preview" ? "Preparing the native scene. First load can take several seconds…" : `${pending}…`}</div>}
      {notice && <div className="fl-notice" role="status">{notice}</div>}
      <div hidden={area !== "workspace"}>
      <section className="fl-environment-section" aria-labelledby="environment-title">
        <div className="fl-step-heading"><h2 id="environment-title">Where are you testing?</h2><p>Each environment preserves its own geometry and execution evidence.</p></div>
        <div className="fl-environment-options">
          <button type="button" className="fl-environment-option" aria-pressed={viewMode === "camera"} disabled={busy || state?.running} onClick={() => void action("Camera workcell", switchToCamera)}><strong>Camera capture</strong><span>Bring a real workcell into the test.</span><small>Live RGB · estimated poses · virtual pick</small></button>
          <button type="button" className="fl-environment-option" aria-pressed={viewMode === "warehouse"} disabled={busy || state?.running} onClick={() => void action("Loading warehouse", loadWarehouse)}><strong>Warehouse kinematics</strong><span>Test repeatable motion and disturbances.</span><small>Saved geometry · joint limits · collision checks</small></button>
          <button type="button" className="fl-environment-option" aria-pressed={viewMode === "physics"} disabled={busy || state?.running || !health?.robosim?.available} title={health?.robosim?.reason ?? undefined} onClick={() => void action("Loading RoboSim physics", loadRoboSim)}><strong>RoboSim contact physics</strong><span>Evaluate native robot and object dynamics.</span><small>{health?.robosim?.available ? "YAM robot · native CPU physics" : health?.robosim?.reason ?? "Physics worker unavailable"}</small></button>
        </div>
        {environmentDefinition && <details className="fl-environment-specification"><summary>Environment specification</summary><dl><div><dt>Source</dt><dd>{environmentDefinition.name}</dd></div><div><dt>Engine</dt><dd>{environmentDefinition.engine}</dd></div><div><dt>Workspace</dt><dd>{environmentDefinition.workspace} · {environmentDefinition.units}</dd></div><div><dt>Fidelity</dt><dd>{environmentDefinition.fidelity}</dd></div><div><dt>Robot</dt><dd>{environmentDefinition.robot}</dd></div><div><dt>Case families</dt><dd>{environmentDefinition.case_families.join(", ") || "No saved families"}</dd></div><div><dt>Execution</dt><dd>{environmentDefinition.execution_backends.map((backend) => backend === "modal_cpu" ? "Modal CPU" : backend === "local" ? "Local" : backend).join(", ")}</dd></div></dl></details>}
      </section>
      <div className="fl-workspace-heading"><div><h2>{viewMode === "camera" ? "Camera workcell" : viewMode === "warehouse" ? "Warehouse workcell" : "Native physics workcell"}</h2></div><div className="fl-toolbar"><button className="fl-button fl-button-secondary" aria-pressed={showEvidence} onClick={() => { setShowEvidence(!showEvidence); setFocusStage(false); }}>{showEvidence ? "Hide execution logs" : "Execution logs"}</button><button className="fl-text-link" aria-pressed={focusStage} onClick={() => setFocusStage(!focusStage)}>{focusStage ? "Show inspector" : "Expand 3D"}</button></div></div>
      <div id="capture" className={`fl-live-grid fl-stage-layout ${focusStage ? "is-focused-stage" : ""} ${viewMode !== "camera" && !showEvidence ? "is-scene-only" : ""}`}>
        <section className="fl-panel fl-simulation-panel">
          <div className="fl-panel-heading"><h2>{viewMode === "physics" ? "RoboSim physics workcell" : viewMode === "warehouse" ? "Warehouse workcell" : "Camera workcell twin"}</h2><span className="fl-status">{state?.running ? "EXECUTING · SIMULATED ACTIONS" : state?.result ? "EXECUTION COMPLETE" : state?.world ? "SCENE READY · NOT EXECUTED" : "AWAITING SETUP"}</span></div>
          <div className="fl-run-controls">
            {viewMode !== "camera" && <label className="fl-field" htmlFor="fl-warehouse-case">{viewMode === "physics" ? "Saved native physics scenario" : "Saved warehouse scenario"}<select id="fl-warehouse-case" value={stageScenario?.case_id ?? selectedCase} disabled={busy || state?.running} onChange={(event) => void action("Loading scenario preview", () => loadScenarioPreview(event.target.value))}><option value="">Choose a saved scenario</option>{(viewMode === "physics" ? physicsScenarios : warehouseScenarios).map((saved) => <option key={saved.case_id} value={saved.case_id}>{saved.name} · {saved.case_id}</option>)}</select></label>}
            <div className="fl-stage-control-grid">
              {viewMode === "physics" ? <label className="fl-field fl-model-field">Native robot model<input readOnly value={`I2RT YAM · ${state?.world?.robot.joint_angles?.length ? `${state.world.robot.joint_angles.length} native joints` : "bimanual native model"}`} /></label> : <label className="fl-field" htmlFor="fl-robot">Robot configuration<select id="fl-robot" value={robotId} disabled={busy || state?.running} onChange={(event) => viewMode === "warehouse" ? setWarehouseRobotId(event.target.value) : setCameraRobotId(event.target.value)}>{robots.length ? robots.map((robot) => <option key={robot.id} value={robot.id} disabled={viewMode === "camera" && (robot.requires_metric ?? robot.kind !== "cartesian") && state?.observed.coordinate_frame !== "workcell_m"}>{robot.name.replace("demonstration ", "")} · {robot.dof} DOF{viewMode === "camera" && (robot.requires_metric ?? robot.kind !== "cartesian") && state?.observed.coordinate_frame !== "workcell_m" ? " · measured calibration required" : ""}</option>) : <option value={robotId}>{robotId === "industrial_6r" ? "Generic industrial 6R arm" : "Cartesian gripper"}</option>}</select></label>}
              <label className="fl-field" htmlFor="fl-policy">Policy adapter{policySelect(policyId, choosePolicy, "fl-policy")}</label>
              <label className="fl-field fl-target-field" htmlFor="fl-target">{viewMode !== "camera" ? "Manifest target" : "Target object"}<select id="fl-target" value={viewMode !== "camera" ? stageTargetId : targetId} onChange={(event) => setTargetId(event.target.value)} disabled={state?.running || viewMode !== "camera"}><option value="">Select an object</option>{stageObjects.map((object) => <option key={object.id} value={object.id}>{object.id} · {object.label}{!object.visible ? " · uncertain" : ""}</option>)}</select></label>
            </div>
            <div className="fl-toolbar">
              {viewMode === "physics" && <button className="fl-text-link" disabled={busy || state?.running || !health?.robosim?.available} onClick={() => void action("Loading RoboSim physics", loadRoboSim)}>Reset physics scene</button>}
              {viewMode === "warehouse" && <button className="fl-text-link" disabled={busy || state?.running} onClick={() => void action("Loading warehouse", loadWarehouse)}>{pending === "Loading warehouse" ? "Loading…" : "Reset warehouse"}</button>}
              <button className="fl-button fl-button-primary" disabled={busy || state?.running || !policyAvailable(policyId) || (viewMode === "camera" ? !state?.calibrated || !targetId : !selectedCase || !state?.world)} onClick={() => void action("Starting execution", viewMode !== "camera" ? startWarehouse : startLive)}>{pending === "Starting execution" ? "Starting…" : viewMode === "physics" ? "Execute physics test" : viewMode === "warehouse" ? "Execute warehouse test" : "Execute live pick"}</button>
              <label className="fl-inline-label">Action pace<select aria-label="Action pace" value={pace} onChange={(event) => setPace(event.target.value)} disabled={state?.running}><option value="1.5">1.5s</option><option value="2.5">2.5s</option><option value="4">4s</option></select></label>
              {state?.running && <><button className="fl-button fl-button-secondary" disabled={busy} onClick={() => void action("Control", () => control(state.paused ? "resume" : "pause"))}>{state.paused ? "Resume policy" : "Pause policy"}</button><button className="fl-button fl-button-secondary" disabled={busy} onClick={() => void action("Stop", () => control("stop"))}>Stop</button></>}
            </div>
            <p className="fl-caption fl-scene-help">{viewMode === "physics" ? "This scene uses RoboSimStudio’s imported YAM robot and the native CPU physics worker. Loading prepares the scene; Execute starts a fresh policy episode. Saved definitions retain their original backend and seeds." : viewMode === "warehouse" ? "Robot selection applies when loading a new warehouse. Saved scenarios keep their robot configuration, seed and disturbance boundary. Execute starts a fresh test." : "During a live run, move the real target after approach begins. Camera updates affect unheld objects; virtually grasped objects remain simulator-owned."}</p>
            <details className="fl-advanced"><summary>Execution details & advanced controls</summary><div className="fl-execution-scope"><span>{state?.world?.robot.kinematics_kind === "robosim_physics" ? `${health?.robosim?.engine ?? "Native CPU physics"} · actual native body and joint state` : state?.world?.robot.kinematics_kind === "six_dof_kinematic" ? "6R: analytic IK + joint limits + rigid-link collision proxies" : "Cartesian: swept collision proxy"}</span><span>{stageScenario?.limits ? `Limits: ${stageScenario.limits.max_actions} actions / ${stageScenario.limits.max_sim_seconds}s simulated` : "Bounded action and simulation budgets"}</span><span>{viewMode === "physics" ? "Native simulation · not a hardware certification" : "Kinematics only · no contact dynamics or hardware certification"}</span></div>
            {viewMode === "physics" && state?.world?.robot.native_physics && <div className="fl-execution-scope"><span>Engine: {state.world.robot.native_physics.engine ?? health?.robosim?.engine ?? "native CPU worker"}</span>{state.world.robot.native_physics.device && <span>Device: {state.world.robot.native_physics.device}</span>}{typeof state.world.robot.native_physics.sim_time === "number" && <span>Native simulation time: {state.world.robot.native_physics.sim_time.toFixed(3)}s</span>}{typeof state.world.robot.native_physics.contact_count === "number" && <span>Native contacts: {state.world.robot.native_physics.contact_count}</span>}{state.world.robot.native_physics.active_arm && <span>Active arm: {state.world.robot.native_physics.active_arm} · idle arm: {state.world.robot.native_physics.idle_arm ?? "unspecified"}</span>}</div>}
            {viewMode === "physics" && !!state?.world?.robot.native_contacts?.length && <details><summary>Inspect actual native contact rows</summary><pre>{JSON.stringify(state.world.robot.native_contacts, null, 2)}</pre></details>}
            {viewMode !== "physics" && robotDescriptor?.motion_validation && <p className="fl-caption">Selected profile: {robotDescriptor.motion_validation}. {robotDescriptor.scope}</p>}
            <div className="fl-toolbar"><button className="fl-text-link" disabled={!session || busy || !state?.observed.objects.length} onClick={() => void action("Snapshot", async () => { const snapshot = await faultline("scenes/snapshot", { session, body: { session_id: session!.session_id } }); downloadJson(snapshot, "faultline-scene-snapshot.json"); setNotice("Downloaded the actual observed scene snapshot."); })}>Download camera scene snapshot</button><button className="fl-text-link" disabled={!state?.running || !["live_capture", "operator_injected"].includes(state?.run_mode ?? "") || busy} onClick={() => void action("Injecting", inject)}>Inject labelled virtual displacement</button></div></details>
          </div>
          <World visualAssets={objectAssets} cameraSessionId={stageScenario?.source === "captured_live_rgb" ? String(stageScenario.provenance.camera_session ?? "") : viewMode === "camera" ? state?.observed.session_id : undefined} world={state?.world ?? null} observed={viewMode === "camera" ? state?.observed : undefined} targetId={stageTargetId} source={state?.world ? state.scenario_source : viewMode === "camera" ? "live_rgb" : "simulation"} provenance={{ ...stageScenario?.provenance, source: state?.scenario_source, run_mode: state?.run_mode }} cinematicDefault />
          <details className="fl-controller-disclosure" open={state?.running || undefined}><summary>Policy decisions & controller state</summary><ControllerPanel selectedPolicyId={policyId} selectedPolicyAvailable={policyAvailable(policyId)} frontierAvailable={policyAvailable("gpt-6.1-sol")} configurationLoaded={!!health} controller={state?.controller} events={liveTraceEvents} episodeId={currentEpisode} runMode={state?.run_mode} running={state?.running ?? false} result={state?.result} /></details>
          {state?.result && <div className="fl-result-wrap"><Result result={state.result} /><button className="fl-text-link" disabled={busy} onClick={() => void action("Loading trace", () => loadEpisode(state.result!.episode_id))}>Open persisted execution trace</button></div>}
        </section>
        <aside className="fl-inspector-aside" aria-label="Camera and execution evidence">
          <div hidden={viewMode !== "camera"}><Camera session={session} state={state} ensureSession={ensureSession} onObjectSelected={(id) => { if (!targetId) setTargetId(id); }} onRefresh={() => void refresh().catch((err) => setError(errorMessage(err)))} /><details className="fl-pad fl-object-assets"><summary>Reconstruct camera objects in 3D</summary><ObjectAssets session={session} observed={state?.observed} assets={objectAssets} onAssetsChange={setObjectAssets} /></details></div>
          <section hidden={!showEvidence} className="fl-panel fl-evidence-panel"><div className="fl-panel-heading"><h2>Execution trace</h2><span className="fl-status">REAL LOGS</span></div><div className="fl-trace-heading"><span className={`fl-status ${state?.running ? "is-live" : ""}`}>{state?.paused ? "PAUSED" : state?.status ?? "IDLE"}</span><small>{state?.run_mode === "scenario_preview" ? "Scene loaded · no execution" : state?.run_mode === "scenario_rerun" ? "Fresh scenario rerun" : state?.run_mode === "operator_injected" ? "Operator injection" : "Live session evidence"}</small></div><Trace events={liveTraceEvents} compact /><p className="fl-caption fl-trace-note">Open an event for the exact action, executor error and provenance. The independent evaluator decides success.</p></section>
        </aside>
      </div>
      <div className="fl-next-step"><div><strong>{state?.result ? "Keep this execution useful." : "Every run can become a regression test."}</strong><p>{state?.result ? liveCapture ? "Review the observed disturbance and save it as a versioned test." : "This scenario is already saved. Rerun it with another policy or compare a release." : viewMode === "camera" ? "Connect the camera, calibrate the work area, and select an object to enable execution." : "Execute a saved scenario to inspect its policy decisions and evaluation."}</p></div><button className="fl-button fl-button-secondary" onClick={() => setArea("regressions")}>Regression tests →</button></div>
      <details className="fl-session-details"><summary>Session & provenance</summary><p>{session ? `Session ${session.session_id}` : "No session created"} · {viewMode === "camera" ? state?.calibrated ? "Calibrated camera · RGB pose estimates" : "Camera calibration required" : "Saved geometry · camera isolated"}</p></details>
      <details className="fl-advice"><summary>Policy diagnostics & Jev analysis</summary><JevPanel session={session} episodeId={state?.result?.episode_id} /></details>
      </div>
      <section id="regressions" hidden={area !== "regressions"} className="fl-section">
        <div className="fl-section-heading"><h2>Preserve and reproduce the failure</h2><p>Capture the initial scene and accepted disturbance boundaries, then execute the saved manifest again.</p></div>
        <div className="fl-regression-grid"><div className="fl-panel fl-pad"><h3>Save the current capture</h3><p className="fl-caption">Review the accepted changes before confirming. A recording and a new execution are separate evidence.</p><div className="fl-disturbances">{disturbances.length ? disturbances.map((d, i) => <div key={i}><b>{d.type} · {d.object_id ?? "workcell"}</b><span>After action {d.after_action_index} · {d.source} · {Math.round(d.confidence * 100)}%</span>{d.position && <code>position [{d.position.map((v) => v.toFixed(3)).join(", ")}]</code>}</div>) : <p className="fl-empty">No accepted live disturbance yet. Move an object during a live run or use the labelled virtual injection.</p>}</div><label className="fl-field">Regression name<input value={caseName} onChange={(e) => setCaseName(e.target.value)} maxLength={120} /></label><label className="fl-checkbox"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={state?.running} /><span>I reviewed the measured changes and confirm this scenario for reproduction.</span></label><p className="fl-caption">{state?.running ? "Wait for this execution to finish before saving." : !liveCapture ? "Start in Camera capture to preserve a physical disturbance. Warehouse and physics scenarios are already in the library." : !disturbances.length ? "A measured object movement during execution is needed before this capture can be saved." : "Confirm the reviewed changes to create an immutable scenario."}</p><button className="fl-button fl-button-primary" disabled={!confirmed || !disturbances.length || !state?.result || !liveCapture || state?.running || busy} onClick={() => void action("Compiling", compile)}>{pending === "Compiling" ? "Saving…" : "Create regression test"}</button></div>
        <div className="fl-panel fl-pad"><h3>Regression library</h3><label className="fl-field">Case<select value={selectedCase} onChange={(e) => setSelectedCase(e.target.value)}><option value="">Choose a saved case</option>{scenarios.map((s) => <option key={s.case_id} value={s.case_id}>{s.name} · {s.case_id}</option>)}</select></label>{scenario ? <><div className="fl-case-info"><span className="fl-status">{SOURCE_NAMES[scenario.source] ?? scenario.source}</span><p><strong>{scenario.name}</strong></p><dl><div><dt>Seed</dt><dd>{scenario.seed}</dd></div><div><dt>Target</dt><dd>{scenario.task.target_id}</dd></div><div><dt>Disturbances</dt><dd>{scenario.disturbances.length}</dd></div><div><dt>Family</dt><dd>{scenario.family}</dd></div></dl><details><summary>Inspect immutable manifest</summary><pre>{JSON.stringify(scenario, null, 2)}</pre></details></div><label className="fl-field" htmlFor="fl-rerun-policy">Rerun policy{policySelect(candidate, setCandidate, "fl-rerun-policy")}</label><div className="fl-toolbar"><button className="fl-button fl-button-primary" disabled={busy || state?.running || !policyAvailable(candidate)} onClick={() => void action("Rerunning", rerun)}>Execute with candidate</button><button className="fl-button fl-button-secondary" onClick={() => { setSuite("saved"); setArea("release"); }}>Compare for release →</button><button className="fl-text-link" onClick={() => downloadJson(scenario, `${scenario.case_id}.json`)}>Download manifest</button>{typeof scenario.provenance.capture_episode_id === "string" && <button className="fl-text-link" disabled={busy} onClick={() => void action("Loading trace", () => loadEpisode(scenario.provenance.capture_episode_id as string))}>View original trace</button>}</div><p className="fl-caption">New environment, episode ID, policy decisions and independent evaluation. Physical camera sync is isolated during saved-case reruns.</p></> : <p className="fl-empty">Captured tests will appear here. Procedural cases appear after a benchmark has actually executed them.</p>}</div></div>
      </section>
      <section id="benchmark" hidden={area !== "release"} className="fl-section"><div className="fl-section-heading"><h2>Compare policies. Gate the release.</h2><p>Each selected case executes twice against the same scenario hash, with a fresh environment for each policy.</p></div><div className="fl-panel fl-pad"><div className="fl-saved-benchmark-controls"><label className="fl-field">Saved release check<select value={selectedBenchmarkId} onChange={(e) => setSelectedBenchmarkId(e.target.value)} disabled={benchmark?.status === "RUNNING"}><option value="">Choose saved execution evidence</option>{savedBenchmarks.map((b) => <option key={b.id} value={b.id}>{b.id} · {POLICY_NAMES[b.candidate_policy] ?? b.candidate_policy} · {b.completed_executions}/{b.total_executions} executions · {b.gate?.verdict ?? b.status}</option>)}</select></label><button className="fl-button fl-button-secondary" disabled={!selectedBenchmarkId || busy || benchmark?.status === "RUNNING"} onClick={() => void action("Loading benchmark", loadSavedBenchmark)}>Load results</button><button className="fl-text-link" disabled={busy} onClick={() => void action("Refreshing benchmarks", loadBenchmarks)}>Refresh saved runs</button></div><details className="fl-comparison-settings" open={!benchmark || undefined}><summary>Comparison settings</summary><div className="fl-execution-configuration"><div><h3>Choose where the comparison runs</h3><p>Every policy gets a fresh environment. Parallelism controls simultaneous executions.</p></div><label className="fl-field">Execution backend<select value={executionBackend} disabled={busy || benchmark?.status === "RUNNING"} onChange={(e) => { const next = e.target.value as "local" | "modal_cpu"; setExecutionBackend(next); setConcurrency(next === "modal_cpu" ? 4 : 2); }}><option value="local">Local</option><option value="modal_cpu">Modal CPU{health?.execution_backends?.find((option) => option.id === "modal_cpu")?.available ? "" : " · unavailable"}</option></select></label><label className="fl-field">Parallel executions<select value={concurrency} disabled={busy || benchmark?.status === "RUNNING"} onChange={(e) => setConcurrency(Number(e.target.value))}>{[1, 2, 4].filter((count) => count <= (executionOption?.max_concurrency ?? 4)).map((count) => <option key={count} value={count}>{count === 1 ? "1 · sequential" : `${count} at a time`}</option>)}</select></label><p className="fl-execution-readiness" role="status">{executionOption?.available ? executionOption.verified ? "Verified execution backend" : "Backend available · execution not yet verified" : executionOption?.reason ?? (executionBackend === "local" ? "Local engine execution" : "Modal CPU is not available")}</p></div><div className="fl-bench-controls"><label className="fl-field" htmlFor="fl-baseline">Baseline{policySelect(baseline, setBaseline, "fl-baseline")}</label><label className="fl-field" htmlFor="fl-candidate">Candidate{policySelect(candidate, setCandidate, "fl-candidate")}</label><label className="fl-field">Scenario suite<select value={suite} onChange={(e) => setSuite(e.target.value)}><option value="saved">Selected saved case · 1 pair</option><option value="1">Procedural simulation · 1 pair</option><option value="10">Procedural simulation · 10 pairs</option><option value="25">Procedural simulation · 25 pairs</option><option value="50">Procedural simulation · 50 pairs</option><option value="100">Procedural simulation · 100 pairs</option><option value="warehouse12">Warehouse kinematics · 12 pairs</option></select></label><label className="fl-field">Minimum paired cases<input type="number" min="1" max="100" value={minimum} onChange={(e) => setMinimum(e.target.value)} /></label><button className="fl-button fl-button-primary" disabled={busy || benchmark?.status === "RUNNING" || !!executionBlockedReason || baseline === candidate || !policyAvailable(baseline) || !policyAvailable(candidate) || (suite === "saved" && !selectedCase) || !(Number(minimum) >= 1)} onClick={() => void action("Benchmark", runBenchmark)}>{benchmark?.status === "RUNNING" ? "Executing…" : "Run release check"}</button></div>{executionBlockedReason && <p className="fl-error" role="status">{executionBlockedReason}</p>}<p className="fl-caption">Gate requires zero forbidden violations, no new critical regressions and ≥80% completion on eligible paired cases. Default minimum: 3. A single pair can correctly return INSUFFICIENT_EVIDENCE.</p></details>
      {benchmark ? <div className="fl-benchmark-results"><div className="fl-job-summary"><strong>{benchmark.execution_backend === "modal_cpu" ? "Modal CPU" : "Local"}</strong><span>{benchmark.concurrency ?? 1} parallel execution limit</span>{typeof benchmark.active_executions === "number" && <span>{benchmark.active_executions} active now</span>}{typeof benchmark.peak_concurrency === "number" && <span>Peak in flight: {benchmark.peak_concurrency}</span>}{typeof benchmark.actual_worker_overlap === "number" && <span>Measured worker overlap: {benchmark.actual_worker_overlap}</span>}</div>{!!benchmark.jobs?.length && <details className="fl-job-progress" open={benchmark.status === "RUNNING" || undefined}><summary>Execution queue · {benchmark.jobs.filter((job) => job.status === "DONE").length} done / {benchmark.jobs.length} jobs</summary><div className="fl-job-list">{benchmark.jobs.map((job, index) => <div className={`fl-job-row is-${job.status.toLowerCase()}`} key={`${job.case_id}-${job.role}-${index}`}><span className="fl-job-state">{job.status}</span><strong>{job.case_id}</strong><span>{job.role} · {POLICY_NAMES[job.policy_id] ?? job.policy_id}</span><small>{job.backend === "modal_cpu" ? "Modal CPU" : "Local"}{job.outcome ? ` · ${job.outcome}` : ""}</small>{job.episode_id && <button className="fl-text-link" disabled={busy} onClick={() => void action("Loading trace", () => loadEpisode(job.episode_id!))}>Trace</button>}</div>)}</div></details>}<p className="fl-caption">{benchmark.id} · A: {benchmark.baseline_policy} · B: {benchmark.candidate_policy}</p><div className="fl-benchmark-progress"><strong>{benchmark.status}</strong><span>{benchmark.completed_executions} / {benchmark.total_executions} actual policy executions complete</span><progress value={benchmark.completed_executions} max={benchmark.total_executions} /></div><div className="fl-source-counts"><span>Procedural executions: {benchmark.results.filter((r) => r.source === "procedural").length}</span><span>Captured-scene reruns: {benchmark.results.filter((r) => r.source === "captured_live_rgb").length}</span><span>Operator-defined executions: {benchmark.results.filter((r) => r.source === "operator_defined").length}</span><span>Frontier executions: {benchmark.results.filter((r) => !r.policy.policy_id.startsWith("scripted_")).length} (included above)</span></div>{benchmark.gate && <div className={`fl-gate ${benchmark.gate.verdict === "PASS" ? "is-pass" : "is-fail"}`}><div><h3>{benchmark.gate.verdict}</h3><p>{benchmark.gate.reasons.join(" · ") || "All configured rules passed."}</p><p>Applied minimum: {benchmark.gate.config.minimum_cases} paired cases · completion threshold: {Math.round(benchmark.gate.config.completion_threshold * 100)}%</p></div><dl><div><dt>Paired / eligible</dt><dd>{benchmark.gate.paired_cases} / {benchmark.gate.eligible_cases}</dd></div><div><dt>Candidate passes</dt><dd>{benchmark.gate.candidate_passes}</dd></div><div><dt>Fixed / regressed</dt><dd>{benchmark.gate.fixes.length} / {benchmark.gate.regressions.length}</dd></div></dl></div>}{benchmark.errors.map((e, i) => <p className="fl-error" key={i}>{typeof e === "string" ? e : JSON.stringify(e)}</p>)}<div className="fl-case-grid" aria-label="Actual paired case progress">{benchmark.cases.map((c) => { const a = benchmark.results.find((r) => r.case_id === c.case_id && r.policy.policy_id === benchmark.baseline_policy); const b = benchmark.results.find((r) => r.case_id === c.case_id && r.policy.policy_id === benchmark.candidate_policy); const evidence = b ?? a; return <button key={c.case_id} disabled={!evidence} className="fl-case-tile" onClick={() => evidence && void action("Loading trace", () => loadEpisode(evidence.episode_id))}><strong>{c.case_id}</strong><small>{SOURCE_NAMES[c.source] ?? c.source}</small><span><b className={a?.outcome === "PASS" ? "fl-case-pass" : ""}>A · {a?.outcome ?? "pending"}</b><b className={b?.outcome === "PASS" ? "fl-case-pass" : ""}>B · {b?.outcome ?? "pending"}</b></span></button>; })}</div><div className="fl-table-scroll"><table className="fl-results-table"><caption>Persisted results · click a trace to inspect exact execution</caption><thead><tr><th>Case / source</th><th>Policy</th><th>Outcome</th><th>Evaluator reason</th><th>Evidence</th></tr></thead><tbody>{benchmark.results.map((r) => <tr key={r.episode_id}><td>{r.case_id}<small>{SOURCE_NAMES[r.source] ?? r.source}</small></td><td>{POLICY_NAMES[r.policy.policy_id] ?? r.policy.policy_id}<small>{r.model_calls} calls · {(r.inference_elapsed_ms / 1000).toFixed(2)}s inference</small></td><td><span className={`fl-outcome ${r.outcome === "PASS" ? "is-pass" : "is-fail"}`}>{r.outcome}</span></td><td><code>{r.reason}</code></td><td><button className="fl-text-link" onClick={() => void action("Loading trace", () => loadEpisode(r.episode_id))}>Trace</button></td></tr>)}</tbody></table></div><button className="fl-text-link" onClick={() => downloadJson(benchmark, `${benchmark.id}.json`)}>Export release evidence</button></div> : <p className="fl-empty">No release check selected. Choose a baseline, candidate and scenario suite, then run a paired comparison. Saved checks remain available above.</p>}
      </div></section>
      {playback && <section className="fl-section" id="playback"><div className="fl-section-heading"><h2>Recorded trace playback</h2><p>{playback.result.episode_id} · {playback.scenario.case_id} · playback only, no policy inference</p></div><div className="fl-playback-grid"><div className="fl-panel"><World world={worlds[playbackIndex] ?? null} targetId={playback.scenario.task.target_id} source={playback.scenario.source} provenance={{ ...playback.scenario.provenance, run_mode: "recorded_trace" }} /><div className="fl-playback-controls"><button className="fl-button fl-button-secondary" disabled={!worlds.length} onClick={() => { if (playbackIndex >= worlds.length - 1) setPlaybackIndex(0); setPlaying(!playing); }}>{playing ? "Pause playback" : "Play recorded states"}</button><input aria-label="Recorded world state" type="range" min="0" max={Math.max(0, worlds.length - 1)} value={playbackIndex} onChange={(e) => { setPlaying(false); setPlaybackIndex(Number(e.target.value)); }} /><span>{worlds.length ? playbackIndex + 1 : 0} / {worlds.length} states</span></div><div className="fl-pad"><Result result={playback.result} /><button className="fl-text-link" onClick={() => downloadJson(playback, `${playback.result.episode_id}.json`)}>Download complete episode evidence</button></div></div><div className="fl-panel"><Trace events={playback.events} /></div></div></section>}
      <footer className="fl-footer"><strong>FAULTLINE Pick</strong><span>RGB estimates → simulated manipulation → independent evaluator. Results describe this virtual workcell.</span><span>Evidence is stored on the local backend. Jev advice is separate from verification.</span><details className="fl-footer-advanced"><summary>Advanced</summary><a href="/preview">Interface previews</a></details></footer>
    </main>
  </div>;
}
