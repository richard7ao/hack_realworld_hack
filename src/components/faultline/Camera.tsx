"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { errorMessage, faultline, type SessionCredentials, type SessionState } from "@/lib/faultline";

type Point = [number, number];
type Mode = "view" | "calibrate" | "object";
type CaptureSource = "laptop_web_rgb" | "desk_view_window_rgb";
export function Camera({ session, state, ensureSession, onObjectSelected, onRefresh }: {
  session: SessionCredentials | null; state: SessionState | null;
  ensureSession: () => Promise<SessionCredentials>; onObjectSelected: (id: string) => void; onRefresh: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const sequence = useRef(0);
  const cameraAttempt = useRef(0);
  const cameraTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestState = useRef(state); latestState.current = state;
  const [connected, setConnected] = useState(false);
  const [captureSource, setCaptureSource] = useState<CaptureSource>("laptop_web_rgb");
  const [syncing, setSyncing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [requestingCamera, setRequestingCamera] = useState(false);
  const [error, setError] = useState("");
  const [frameSize, setFrameSize] = useState<Point>([640, 480]);
  const [accepted, setAccepted] = useState(0);
  const [mode, setMode] = useState<Mode>("view");
  const [corners, setCorners] = useState<Point[]>([]);
  const [cornersInput, setCornersInput] = useState("");
  const [boxInput, setBoxInput] = useState("");
  const [boxStart, setBoxStart] = useState<Point | null>(null);
  const [boxEnd, setBoxEnd] = useState<Point | null>(null);
  const [width, setWidth] = useState(""); const [depth, setDepth] = useState("");
  const [objectId, setObjectId] = useState("parcel_A"); const [label, setLabel] = useState("Small parcel");
  const [dimensions, setDimensions] = useState<[string, string, string]>(["", "", ""]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]); const [deviceId, setDeviceId] = useState("");

  function cancelCameraRequest() {
    cameraAttempt.current += 1;
    if (cameraTimeout.current) clearTimeout(cameraTimeout.current);
    stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null;
    setConnected(false); setRequestingCamera(false); setBusy(false);
    setError("Camera request cancelled. Check camera permissions in Chrome, then reconnect at http://localhost:3300/lab.");
  }
  function disconnect() {
    stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null;
    setConnected(false); setAccepted(0);
  }
  useEffect(() => () => {
    cameraAttempt.current += 1;
    if (cameraTimeout.current) clearTimeout(cameraTimeout.current);
    stream.current?.getTracks().forEach((track) => track.stop());
  }, []);
  async function refreshDevices() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error("Camera discovery requires Chrome on localhost or HTTPS.");
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"));
    } catch (err) { setError(errorMessage(err)); }
  }
  async function connect(source: CaptureSource = "laptop_web_rgb") {
    const attempt = ++cameraAttempt.current;
    const timeoutSeconds = source === "desk_view_window_rgb" ? 90 : 30;
    setBusy(true); setRequestingCamera(true); setError("");
    cameraTimeout.current = setTimeout(() => {
      if (cameraAttempt.current !== attempt) return;
      cameraAttempt.current += 1;
      stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null;
      setConnected(false); setBusy(false); setRequestingCamera(false);
      setError(source === "desk_view_window_rgb" ? "Window sharing did not respond within 90 seconds. In Chrome, select the Desk View window and allow screen recording in macOS, then try again. Any late stream will be closed." : "Camera permission did not respond within 30 seconds. Open http://localhost:3300/lab in Chrome, allow camera access in the browser and macOS, then reconnect. Any late camera stream will be closed.");
    }, timeoutSeconds * 1000);
    try {
      if (!navigator.mediaDevices) throw new Error("Capture requires localhost or HTTPS. Open http://localhost:3300/lab in Chrome.");
      // Display capture must start directly inside the button gesture, before any await.
      const captureRequest = source === "desk_view_window_rgb"
        ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        : navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
      const capture = await captureRequest;
      if (cameraAttempt.current !== attempt) { capture.getTracks().forEach((track) => track.stop()); return; }
      stream.current?.getTracks().forEach((track) => track.stop()); stream.current = capture;
      const credentials = await ensureSession();
      if (cameraAttempt.current !== attempt) { capture.getTracks().forEach((track) => track.stop()); return; }
      sequence.current = Math.max(sequence.current, latestState.current?.observed.seq ?? 0);
      if (video.current) { video.current.srcObject = capture; await video.current.play(); }
      if (cameraAttempt.current !== attempt) { capture.getTracks().forEach((track) => track.stop()); return; }
      if (cameraTimeout.current) clearTimeout(cameraTimeout.current);
      setCaptureSource(source); setConnected(true); setSyncing(true);
      void navigator.mediaDevices.enumerateDevices().then((all) => { if (cameraAttempt.current === attempt) setDevices(all.filter((d) => d.kind === "videoinput")); }).catch(() => {});
      capture.getVideoTracks()[0]?.addEventListener("ended", () => setConnected(false));
      if (credentials.expires_at_ms < Date.now()) throw new Error("Camera session expired. Reload to create a fresh session.");
    } catch (err) {
      if (cameraAttempt.current === attempt) {
        stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null;
        setConnected(false); setError(errorMessage(err));
      }
    } finally {
      if (cameraAttempt.current === attempt) {
        if (cameraTimeout.current) clearTimeout(cameraTimeout.current);
        setBusy(false); setRequestingCamera(false);
      }
    }
  }
  useEffect(() => {
    if (!connected || !session || !syncing) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController(); const canvas = document.createElement("canvas");
    async function send() {
      const element = video.current;
      if (!active) return;
      try {
        if (element && element.readyState >= 2 && element.videoWidth) {
          const w = captureSource === "desk_view_window_rgb" ? 640 : Math.min(640, element.videoWidth);
          const h = captureSource === "desk_view_window_rgb" ? 480 : Math.round(element.videoHeight * w / element.videoWidth);
          canvas.width = w; canvas.height = h;
          setFrameSize((previous) => previous[0] === w && previous[1] === h ? previous : [w, h]);
          const context = canvas.getContext("2d")!;
          context.fillStyle = "#20251d"; context.fillRect(0, 0, w, h);
          const scale = Math.min(w / element.videoWidth, h / element.videoHeight);
          const dw = element.videoWidth * scale; const dh = element.videoHeight * scale;
          context.drawImage(element, (w - dw) / 2, (h - dh) / 2, dw, dh);
          const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", .8));
          if (jpeg && active) {
            sequence.current = Math.max(sequence.current + 1, (latestState.current?.observed.seq ?? 0) + 1);
            await faultline(`camera/${session!.session_id}/frame?seq=${sequence.current}&timestamp_ms=${Date.now()}&source=${captureSource}`, { binary: jpeg, session, signal: abort.signal });
            if (active) { setAccepted((n) => n + 1); setError(""); }
          }
        }
      } catch (err) { if (active) setError(errorMessage(err)); }
      if (active) timer = setTimeout(() => void send(), 200);
    }
    void send();
    return () => { active = false; clearTimeout(timer); abort.abort(); };
  }, [connected, session, syncing, captureSource]);

  function point(event: PointerEvent<SVGSVGElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(frameSize[0], (event.clientX - rect.left) * frameSize[0] / rect.width)), Math.max(0, Math.min(frameSize[1], (event.clientY - rect.top) * frameSize[1] / rect.height))];
  }
  function down(event: PointerEvent<SVGSVGElement>) {
    if (mode === "calibrate") { if (corners.length < 4) setCorners([...corners, point(event)]); }
    if (mode === "object") { event.currentTarget.setPointerCapture(event.pointerId); setBoxStart(point(event)); setBoxEnd(point(event)); }
  }
  function typedSelection(kind: "corners" | "box") {
    try {
      const values = (kind === "corners" ? cornersInput : boxInput).trim().split(/[\s,;]+/).map(Number);
      const count = kind === "corners" ? 8 : 4;
      if (values.length !== count || values.some((v) => !Number.isFinite(v))) throw new Error(`Enter ${count} finite pixel coordinates.`);
      if (kind === "corners") {
        const points = Array.from({ length: 4 }, (_, i) => [values[i * 2]!, values[i * 2 + 1]!] as Point);
        if (points.some(([x, y]) => x < 0 || y < 0 || x > frameSize[0] || y > frameSize[1])) throw new Error("Corners must be inside the camera frame.");
        setCorners(points);
      } else {
        const [x, y, w, h] = values as [number, number, number, number];
        if (x < 0 || y < 0 || w < 8 || h < 8 || x + w > frameSize[0] || y + h > frameSize[1]) throw new Error("Use an in-frame box at least 8 × 8 pixels.");
        setBoxStart([x, y]); setBoxEnd([x + w, y + h]);
      }
      setError("");
    } catch (err) { setError(errorMessage(err)); }
  }
  async function saveCalibration() {
    if (!session) return;
    setBusy(true); setError("");
    try {
      const measured = width !== "" || depth !== "";
      if (measured && (!(Number(width) > 0) || !(Number(depth) > 0))) throw new Error("Enter both measured width and depth, or leave both empty for normalized units.");
      await faultline("workcell/calibration", { session, body: { session_id: session.session_id, calibration: { corners, width: measured ? Number(width) : null, depth: measured ? Number(depth) : null } } });
      setMode("object"); setBoxStart(null); setBoxEnd(null); setObjectId("parcel_A"); onRefresh();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function saveObject() {
    if (!session || !boxStart || !boxEnd) return;
    setBusy(true); setError("");
    try {
      const bbox = [Math.min(boxStart[0], boxEnd[0]), Math.min(boxStart[1], boxEnd[1]), Math.abs(boxEnd[0] - boxStart[0]), Math.abs(boxEnd[1] - boxStart[1])].map(Math.round);
      if (bbox[2]! < 8 || bbox[3]! < 8) throw new Error("Select a box at least 8 × 8 pixels around the object.");
      if (!/^[a-zA-Z0-9_-]+$/.test(objectId)) throw new Error("Object ID uses letters, numbers, underscores or hyphens.");
      const declared = dimensions.some((v) => v !== "");
      if (declared && !dimensions.every((v) => Number(v) > 0)) throw new Error("Declare all three positive dimensions, or leave all empty to estimate footprint.");
      await faultline("objects/seed", { session, body: { session_id: session.session_id, id: objectId, label, bbox, dimensions: declared ? dimensions.map(Number) : null } });
      onObjectSelected(objectId); onRefresh(); setBoxStart(null); setBoxEnd(null);
      const n = Math.min(90, 65 + (latestState.current?.observed.objects.length ?? 0) + (latestState.current?.observed.objects.some((o) => o.id === objectId) ? 0 : 1));
      setObjectId(`parcel_${String.fromCharCode(n)}`);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  const disabled = busy || state?.running;
  return <section className="fl-panel fl-camera-panel">
    <div className="fl-panel-heading"><h2>Physical workcell</h2><span className={`fl-status ${connected && accepted ? "is-live" : ""}`}>{connected && accepted ? "REAL CAMERA" : "CAMERA OFFLINE"}</span></div>
    <div className="fl-camera-stage" style={{ aspectRatio: `${frameSize[0]} / ${frameSize[1]}` }}>
      <video ref={video} autoPlay muted playsInline aria-label={captureSource === "desk_view_window_rgb" ? "Selected Desk View window RGB feed" : "Live laptop or Continuity Camera feed"} />
      {!connected && <div className="fl-camera-empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden><path d="M3 7h4l2-3h6l2 3h4v13H3z" /><circle cx="12" cy="13" r="4" /></svg><p>Place three unmarked objects on a contrasting table.</p><span>Fixed camera · clear view · no markers</span></div>}
      {connected && <svg className={`fl-camera-overlay ${mode !== "view" ? "is-selecting" : ""}`} viewBox={`0 0 ${frameSize[0]} ${frameSize[1]}`} aria-label={mode === "calibrate" ? "Select workspace corners" : "Drag to select object"} onPointerDown={down} onPointerMove={(e) => { if (mode === "object" && boxStart && e.buttons) setBoxEnd(point(e)); }} onPointerUp={(e) => { if (mode === "object" && boxStart) { setBoxEnd(point(e)); e.currentTarget.releasePointerCapture(e.pointerId); } }}>
        {state?.observed.objects.map((o) => o.bbox && <g key={o.id}><rect x={o.bbox[0]} y={o.bbox[1]} width={o.bbox[2]} height={o.bbox[3]} fill="transparent" stroke={o.visible ? "#b6f000" : "#f3ad53"} strokeWidth="2" strokeDasharray={o.visible ? undefined : "6 4"} /><text x={o.bbox[0]} y={Math.max(16, o.bbox[1] - 5)} fill="#fff" stroke="#1b241c" strokeWidth="3" paintOrder="stroke" fontSize="13">{o.id} · {Math.round(o.confidence * 100)}%</text></g>)}
        {corners.length > 1 && <polyline points={corners.map((p) => p.join(",")).join(" ") + (corners.length === 4 ? ` ${corners[0]!.join(",")}` : "")} fill="none" stroke="#b6f000" strokeWidth="2" />}
        {corners.map((p, i) => <g key={i}><circle cx={p[0]} cy={p[1]} r="6" fill="#b6f000" stroke="#24321f" /><text x={p[0] + 9} y={p[1] + 4} fill="#fff" stroke="#24321f" strokeWidth="2" paintOrder="stroke" fontSize="14">{i + 1}</text></g>)}
        {boxStart && boxEnd && <rect x={Math.min(boxStart[0], boxEnd[0])} y={Math.min(boxStart[1], boxEnd[1])} width={Math.abs(boxEnd[0] - boxStart[0])} height={Math.abs(boxEnd[1] - boxStart[1])} stroke="#fff" strokeWidth="2" fill="#b6f00033" />}
      </svg>}
    </div>
    <div className="fl-camera-controls">
      <div className="fl-toolbar"><button className="fl-button fl-button-primary" disabled={busy} onClick={() => connected ? disconnect() : void connect()}>{requestingCamera ? "Waiting for camera…" : connected ? "Disconnect camera" : "Connect camera"}</button>{!connected && <button className="fl-button fl-button-secondary" disabled={busy} onClick={() => void connect("desk_view_window_rgb")}>Share Desk View window</button>}{requestingCamera && <button className="fl-button fl-button-secondary" onClick={cancelCameraRequest}>Cancel camera request</button>}{connected && <button className="fl-button fl-button-secondary" onClick={() => setSyncing(!syncing)}>{syncing ? "Pause frame sync" : "Resume frame sync"}</button>}</div>
      {!connected && <button className="fl-text-link" disabled={busy} onClick={() => void refreshDevices()}>Refresh available cameras</button>}
      {devices.length > 0 && <label className="fl-field">Camera source<select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={connected}><option value="">System default</option>{devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Camera"}</option>)}</select></label>}
      <p className="fl-caption">{connected ? `${captureSource === "desk_view_window_rgb" ? "Desk View window RGB" : "Laptop / Continuity Camera RGB"} · ${accepted} JPEG frames accepted · up to 5 fps · ${frameSize.join(" × ")}` : "For Desk View, click Share Desk View window and select the already-open Desk View window in Chrome’s chooser. Laptop webcam and Continuity Camera also work."} {connected && !syncing && "Frame sync paused."}</p>
      {captureSource === "desk_view_window_rgb" && connected && <p className="fl-caption">Window capture only · RGB, no depth. Keep Desk View’s window size and framing fixed after calibration.</p>}
      <div className="fl-toolbar"><button className="fl-button fl-button-secondary" disabled={!connected || disabled} onClick={() => { setMode("calibrate"); setCorners([]); setBoxStart(null); setBoxEnd(null); }}>Set workspace</button><button className="fl-button fl-button-secondary" disabled={!connected || !state?.calibrated || disabled} onClick={() => { setMode("object"); setBoxStart(null); setBoxEnd(null); }}>Select / correct object</button>{mode !== "view" && <button className="fl-text-link" onClick={() => { setMode("view"); setBoxStart(null); setBoxEnd(null); }}>Finish selection</button>}</div>
      {mode === "calibrate" && <div className="fl-selection-form"><p><strong>Click {corners.length + 1 > 4 ? "complete" : `corner ${corners.length + 1} of 4`}.</strong> Top-left → top-right → bottom-right → bottom-left.</p><details><summary>Enter workspace coordinates with keyboard</summary><label className="fl-field">Four corners in pixels, clockwise<input value={cornersInput} onChange={(e) => setCornersInput(e.target.value)} placeholder="20,20; 620,20; 620,460; 20,460" /></label><button className="fl-button fl-button-secondary" disabled={disabled} onClick={() => typedSelection("corners")}>Apply typed corners</button></details><div className="fl-two-fields"><label className="fl-field">Measured width (m)<input type="number" step="0.01" min="0.01" value={width} onChange={(e) => setWidth(e.target.value)} placeholder="Optional" /></label><label className="fl-field">Measured depth (m)<input type="number" step="0.01" min="0.01" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="Optional" /></label></div><p className="fl-caption">Leave both empty for normalized units. Recalibrating clears object selections.</p><button className="fl-button fl-button-primary" disabled={corners.length !== 4 || disabled} onClick={() => void saveCalibration()}>Save workspace</button><button className="fl-text-link" onClick={() => setCorners([])}>Reset corners</button></div>}
      {mode === "object" && <div className="fl-selection-form"><p><strong>Drag a tight box around one object.</strong> Give it a stable ID. Repeat for three objects.</p><details><summary>Enter object coordinates with keyboard</summary><label className="fl-field">Box in pixels: x, y, width, height<input value={boxInput} onChange={(e) => setBoxInput(e.target.value)} placeholder="100,120,150,60" /></label><button className="fl-button fl-button-secondary" disabled={disabled} onClick={() => typedSelection("box")}>Apply typed box</button></details><div className="fl-two-fields"><label className="fl-field">Object ID<input value={objectId} onChange={(e) => setObjectId(e.target.value)} maxLength={64} /></label><label className="fl-field">Label<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></label></div><div className="fl-three-fields">{["Width", "Depth", "Height"].map((name, index) => <label className="fl-field" key={name}>{name} ({state?.observed.coordinate_frame === "workcell_m" ? "m" : "norm."})<input type="number" min="0.001" step="0.01" placeholder="Estimate" value={dimensions[index]} onChange={(e) => setDimensions((old) => old.map((v, i) => i === index ? e.target.value : v) as [string, string, string])} /></label>)}</div><p className="fl-caption">Blank dimensions estimate the planar footprint and assume 0.04 height. RGB does not measure full 3D geometry.</p><button className="fl-button fl-button-primary" disabled={!boxStart || !boxEnd || disabled} onClick={() => void saveObject()}>Track this object</button></div>}
      {error && <p className="fl-error" role="alert">{error}</p>}
      {!!state?.observed.objects.length && <div className="fl-object-list">{state.observed.objects.map((o) => <div key={o.id}><span><b>{o.id}</b><small>{o.source} · {o.visible ? `${Math.round(o.confidence * 100)}% confidence` : "NOT VISIBLE / uncertain"}</small></span><button className="fl-text-link" disabled={disabled} onClick={() => { setObjectId(o.id); setLabel(o.label); setDimensions(o.dimensions.map(String) as [string, string, string]); setMode("object"); setBoxStart(null); setBoxEnd(null); }}>Correct</button></div>)}</div>}
    </div>
  </section>;
}
