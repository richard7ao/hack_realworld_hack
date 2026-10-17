"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { World } from "@/components/faultline/World";
import { Result, Trace } from "@/components/faultline/Trace";
import { errorMessage, faultline, POLICY_NAMES, type Benchmark, type Episode, type Health, type SessionCredentials, type SimWorld } from "@/lib/faultline";
import "../lab/lab.css";
import "./parallel.css";

export default function ParallelRuns() {
  const [health, setHealth] = useState<Health | null>(null);
  const [count, setCount] = useState("50");
  const [baseline, setBaseline] = useState("scripted_open_loop");
  const [candidate, setCandidate] = useState("scripted_reobserve");
  const [concurrency, setConcurrency] = useState("4");
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);
  const [saved, setSaved] = useState<Benchmark[]>([]);
  const [selectedRun, setSelectedRun] = useState("");
  const [selectedCase, setSelectedCase] = useState("");
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [frame, setFrame] = useState(0);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const credentials = useRef<SessionCredentials | null>(null);
  const initiallyLoaded = useRef(false);
  const episodeRequest = useRef(0);
  const load = useCallback(async (id: string) => {
    const data = await faultline<Benchmark>(`benchmarks/${encodeURIComponent(id)}`);
    setBenchmark(data); setSelectedRun(data.id); setEpisode(null); setSelectedCase("");
    setBaseline(data.baseline_policy); setCandidate(data.candidate_policy); setConcurrency(String(data.concurrency ?? 4));
    if ([50, 100].includes(data.cases.length)) setCount(String(data.cases.length));
    setNotice(`Loaded saved Modal execution ${data.id}. No new policy execution was started.`);
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function fetchCatalog() {
      try {
        const [status, runs] = await Promise.all([faultline<Health>("health"), faultline<{ benchmarks: Benchmark[] }>("benchmarks")]);
        if (cancelled) return; setHealth(status);
        const modalRuns = runs.benchmarks.filter((run) => run.execution_backend === "modal_cpu"); setSaved(modalRuns);
        if (!initiallyLoaded.current && modalRuns.length) { initiallyLoaded.current = true; await load(modalRuns[0]!.id); }
      } catch (err) { if (!cancelled) setError(errorMessage(err)); }
    }
    void fetchCatalog(); const timer = setInterval(() => void fetchCatalog(), 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    if (!benchmark || benchmark.status !== "RUNNING") return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>; const id = benchmark.id;
    async function poll() { try { const next = await faultline<Benchmark>(`benchmarks/${encodeURIComponent(id)}`); if (!cancelled) setBenchmark(next); } catch (err) { if (!cancelled) setError(errorMessage(err)); } if (!cancelled) timer = setTimeout(() => void poll(), 600); }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [benchmark?.id, benchmark?.status]);
  const backend = health?.execution_backends?.find((entry) => entry.id === "modal_cpu");
  const supported = (id: string) => !!health?.policies.some((policy) => policy.id === id && policy.available) && !!backend?.supported_policies.includes(id);
  const blocked = !backend?.available ? backend?.reason ?? "Modal CPU is unavailable. Connect the execution backend before starting." : !supported(baseline) || !supported(candidate) ? "Choose two supported scripted policies. This Modal worker does not execute frontier-model adapters." : baseline === candidate ? "Choose different baseline and candidate policies." : "";
  const running = benchmark?.status === "RUNNING";
  async function act(name: string, operation: () => Promise<void>) { setPending(name); setError(""); try { await operation(); } catch (err) { setError(errorMessage(err)); } finally { setPending(""); } }
  async function start() {
    if (blocked) throw new Error(blocked);
    if (!credentials.current || credentials.current.expires_at_ms <= Date.now()) credentials.current = await faultline<SessionCredentials>("camera/session", { method: "POST" });
    const session = credentials.current;
    const data = await faultline<Benchmark>("benchmarks/run", { session, body: { session_id: session.session_id, generated_count: Number(count), case_ids: [], baseline, candidate, execution_backend: "modal_cpu", concurrency: Number(concurrency), gate: { minimum_cases: 3, completion_threshold: .8 } } });
    initiallyLoaded.current = true; setBenchmark(data); setSelectedRun(data.id); setEpisode(null); setSelectedCase("");
    setNotice(`Started ${count} case pairs on Modal CPU. Job status and counts below come from actual execution.`);
  }
  async function inspect(caseId: string, episodeId: string) {
    const request = ++episodeRequest.current; setSelectedCase(caseId); setEpisode(null);
    const evidence = await faultline<Episode>(`episodes/${encodeURIComponent(episodeId)}`);
    if (request !== episodeRequest.current) return;
    setEpisode(evidence); const snapshots = evidence.events.filter((event) => event.kind === "sim.state"); setFrame(Math.max(0, snapshots.length - 1));
  }
  const states = episode?.events.filter((event) => event.kind === "sim.state").map((event) => event.data as unknown as SimWorld) ?? [];
  const jobs = benchmark?.jobs ?? [];
  const done = jobs.filter((job) => job.status === "DONE").length;
  const queued = jobs.filter((job) => job.status === "QUEUED").length;
  const inFlight = jobs.filter((job) => job.status === "RUNNING").length;
  const failures = jobs.filter((job) => job.status === "ERROR").length;
  function policies(value: string, change: (next: string) => void) { return <select value={value} disabled={running || !!pending} onChange={(event) => change(event.target.value)}>{Object.entries(POLICY_NAMES).map(([id, label]) => <option key={id} value={id} disabled={!supported(id)}>{label}{!supported(id) ? " · unsupported on Modal" : ""}</option>)}</select>; }
  return <div className="theme-e fl-lab fl-parallel"><header className="fl-header"><a className="fl-wordmark" href="/lab">FAULTLINE <span>Pick</span></a><nav aria-label="Product navigation"><a href="/lab">Workspace</a><a href="/robosim">RoboSim</a><a href="/production">Production line</a><a href="/parallel" aria-current="page">Parallel runs</a></nav><span className={`fl-status ${backend?.available ? "is-live" : "is-error"}`}>{backend?.verified ? "MODAL VERIFIED" : backend?.available ? "MODAL AVAILABLE" : "MODAL UNAVAILABLE"}</span></header>
    <main className="fl-main"><div className="fl-title-row"><div><h1>Many scenarios. One release decision.</h1><p>Run 50 or 100 reproducible case pairs across up to four Modal CPU workers. Inspect the evidence from every episode.</p></div></div>
      {error && <div className="fl-error fl-banner" role="alert">{error}<button className="fl-text-link" onClick={() => setError("")}>Dismiss</button></div>}{notice && <p className="fl-notice" role="status">{notice}</p>}
      <section className="fl-panel fl-parallel-setup"><div className="fl-parallel-setup-heading"><h2>Configure a parallel comparison</h2><p>One case runs twice: once with the baseline, once with the candidate. Modal executes procedural kinematics with scripted policies.</p></div><div className="fl-parallel-controls"><label className="fl-field">Cases<select value={count} disabled={running || !!pending} onChange={(event) => setCount(event.target.value)}><option value="50">50 pairs · 100 episodes</option><option value="100">100 pairs · 200 episodes</option></select></label><label className="fl-field">Baseline{policies(baseline, setBaseline)}</label><label className="fl-field">Candidate{policies(candidate, setCandidate)}</label><label className="fl-field">Worker limit<select value={concurrency} disabled={running || !!pending} onChange={(event) => setConcurrency(event.target.value)}>{[1, 2, 4].filter((limit) => limit <= (backend?.max_concurrency ?? 4)).map((limit) => <option key={limit} value={limit}>{limit} concurrent {limit === 1 ? "worker" : "workers"}</option>)}</select></label><button className="fl-button fl-button-primary" disabled={!!blocked || !!pending || running} onClick={() => void act("start", start)}>{pending === "start" ? "Starting…" : running ? "Executing on Modal…" : "Run on Modal CPU"}</button></div>{blocked && <p className="fl-caption" role="status">{blocked}</p>}<p className="fl-caption">Case count and worker count are separate. This backend uses a bounded pool of up to four concurrent workers. Frontier models, camera captures and native physics use other execution paths in Workspace.</p></section>
      <div className="fl-parallel-saved"><label className="fl-field">Saved Modal run<select value={selectedRun} disabled={running || !!pending} onChange={(event) => setSelectedRun(event.target.value)}><option value="">Choose persisted evidence</option>{saved.map((run) => <option key={run.id} value={run.id}>{run.id} · {run.completed_executions}/{run.total_executions} episodes · {run.gate?.verdict ?? run.status}</option>)}</select></label><button className="fl-button fl-button-secondary" disabled={!selectedRun || running || !!pending} onClick={() => void act("load", () => load(selectedRun))}>Load run</button></div>
      {benchmark ? <><section className="fl-parallel-metrics" aria-label="Actual execution progress"><div><span>Episodes completed</span><strong>{benchmark.completed_executions}<small> / {benchmark.total_executions}</small></strong></div><div><span>Cases in this run</span><strong>{benchmark.cases.length}</strong></div><div><span>In flight now</span><strong>{benchmark.active_executions ?? inFlight}<small> / {benchmark.concurrency ?? 1}</small></strong></div><div><span>Measured worker overlap</span><strong>{benchmark.actual_worker_overlap ?? "—"}</strong></div><div><span>Peak in flight</span><strong>{benchmark.peak_concurrency ?? "—"}</strong></div></section><p className="fl-parallel-progress-note">A: {POLICY_NAMES[benchmark.baseline_policy] ?? benchmark.baseline_policy} · B: {POLICY_NAMES[benchmark.candidate_policy] ?? benchmark.candidate_policy} · {benchmark.id}</p><p className="fl-parallel-progress-note">{benchmark.status} · {queued} queued · {inFlight} in flight · {done} done · {failures} errors. In flight may include Modal scheduling time. Worker overlap comes from returned worker timestamps.</p><progress className="fl-parallel-progress" max={Math.max(1, benchmark.total_executions)} value={benchmark.completed_executions} aria-label="Completed policy episodes" />
      {benchmark.gate && <section className={`fl-gate ${benchmark.gate.verdict === "PASS" ? "is-pass" : "is-fail"}`}><div><h2>{benchmark.gate.verdict}</h2><p>{benchmark.gate.reasons.join(" · ") || "All configured release rules passed."}</p><p>Minimum {benchmark.gate.config.minimum_cases} paired cases · {Math.round(benchmark.gate.config.completion_threshold * 100)}% completion threshold</p></div><dl><div><dt>Paired / eligible</dt><dd>{benchmark.gate.paired_cases} / {benchmark.gate.eligible_cases}</dd></div><div><dt>Fixes / regressions</dt><dd>{benchmark.gate.fixes.length} / {benchmark.gate.regressions.length}</dd></div></dl></section>}
      <div className={`fl-parallel-grid-layout ${selectedCase ? "has-inspector" : ""}`}><section aria-label="Paired case executions"><div className="fl-parallel-grid-heading"><h2>Case matrix</h2><p>A = baseline · B = candidate. Select an evaluated episode to inspect its recorded states.</p></div><div className="fl-parallel-case-grid">{benchmark.cases.map((item, index) => {
        const a = jobs.find((job) => job.case_id === item.case_id && job.policy_id === benchmark.baseline_policy); const b = jobs.find((job) => job.case_id === item.case_id && job.policy_id === benchmark.candidate_policy);
        const ar = benchmark.results.find((result) => result.case_id === item.case_id && result.policy.policy_id === benchmark.baseline_policy); const br = benchmark.results.find((result) => result.case_id === item.case_id && result.policy.policy_id === benchmark.candidate_policy);
        const episodeId = b?.episode_id ?? br?.episode_id ?? a?.episode_id ?? ar?.episode_id;
        return <button key={item.case_id} className="fl-parallel-case" aria-pressed={selectedCase === item.case_id} disabled={!episodeId || pending === "inspect"} onClick={() => episodeId && void act("inspect", () => inspect(item.case_id, episodeId))}><strong>Case {String(index + 1).padStart(2, "0")}</strong><small>{item.source === "procedural" ? "Procedural kinematics" : item.source}</small><span className={(a?.outcome ?? ar?.outcome) === "PASS" ? "is-pass" : ""}>A <b>{a?.outcome ?? ar?.outcome ?? a?.status ?? "PENDING"}</b></span><span className={(b?.outcome ?? br?.outcome) === "PASS" ? "is-pass" : ""}>B <b>{b?.outcome ?? br?.outcome ?? b?.status ?? "PENDING"}</b></span><code>{item.case_id}</code></button>;
      })}</div></section>{selectedCase && <aside className="fl-panel fl-parallel-inspector"><div className="fl-panel-heading"><h2>Episode inspector</h2><button className="fl-text-link" onClick={() => { ++episodeRequest.current; setSelectedCase(""); setEpisode(null); }}>Close</button></div>{episode ? <><div className="fl-pad fl-parallel-inspector-meta"><strong>{episode.scenario.name}</strong><p>{episode.scenario.family} · {episode.scenario.case_id}</p><p>Recorded evidence · no policy inference during playback</p><div className="fl-toolbar">{benchmark.results.filter((result) => result.case_id === selectedCase).map((result) => <button className="fl-button fl-button-secondary" key={result.episode_id} aria-pressed={episode.result.episode_id === result.episode_id} disabled={!!pending} onClick={() => void act("inspect", () => inspect(selectedCase, result.episode_id))}>{result.policy.policy_id === benchmark.baseline_policy ? "A · Baseline" : "B · Candidate"} · {result.outcome}</button>)}</div></div><World world={states[frame] ?? null} targetId={episode.scenario.task.target_id} source={episode.scenario.source} provenance={{ ...episode.scenario.provenance, run_mode: "recorded_trace" }} /><div className="fl-playback-controls"><input type="range" aria-label="Recorded simulation state" min="0" max={Math.max(0, states.length - 1)} value={frame} disabled={!states.length} onChange={(event) => setFrame(Number(event.target.value))} /><span>{states.length ? frame + 1 : 0} / {states.length} recorded states</span></div><div className="fl-pad"><Result result={episode.result} /><details><summary>Scenario manifest</summary><pre>{JSON.stringify(episode.scenario, null, 2)}</pre></details></div><Trace events={episode.events} /></> : <p className="fl-empty fl-pad">{pending === "inspect" ? "Loading persisted episode…" : "Episode evidence could not be loaded. Select another completed case."}</p>}</aside>}</div>{benchmark.errors.map((entry, index) => <p className="fl-error" key={index}>{typeof entry === "string" ? entry : JSON.stringify(entry)}</p>)}</> : <section className="fl-parallel-empty"><h2>Ready to run at scale.</h2><p>Start a comparison or load saved Modal evidence. The case matrix appears when actual case definitions are returned by the backend.</p></section>}
      <footer className="fl-footer"><strong>FAULTLINE Pick</strong><span>Modal CPU · procedural kinematics · independent evaluation</span><a href="/lab">Return to workspace</a></footer>
    </main></div>;
}
