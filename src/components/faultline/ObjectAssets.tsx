"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, faultline, type ObservedScene, type SessionCredentials } from "@/lib/faultline";
import type { ObjectAssetJob } from "./world-view";

export function ObjectAssets({ session, observed, assets, onAssetsChange }: { session: SessionCredentials | null; observed?: ObservedScene; assets: ObjectAssetJob[]; onAssetsChange: (assets: ObjectAssetJob[]) => void }) {
  const [selectedId, setSelectedId] = useState("");
  const [knownFootprint, setKnownFootprint] = useState(false);
  const [widthCm, setWidthCm] = useState("14");
  const [depthCm, setDepthCm] = useState("4");
  const footprintValid = [Number(widthCm), Number(depthCm)].every((value) => Number.isFinite(value) && value > 0 && value <= 1000);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const update = useRef(onAssetsChange); update.current = onAssetsChange;
  const objects = observed?.objects.filter((object) => object.visible && !!object.bbox) ?? [];
  const object = objects.find((entry) => entry.id === selectedId) ?? objects[0];
  const sessionAssets = assets.filter((asset) => asset.camera_session === session?.session_id);
  const refresh = useCallback(async () => {
    if (!session) return;
    const result = await faultline<{ assets: ObjectAssetJob[] }>(`assets?session_id=${encodeURIComponent(session.session_id)}`, { session });
    update.current(result.assets);
  }, [session]);
  useEffect(() => {
    if (!session) { update.current([]); return; }
    let cancelled = false;
    async function load() { try { const result = await faultline<{ assets: ObjectAssetJob[] }>(`assets?session_id=${encodeURIComponent(session!.session_id)}`, { session }); if (!cancelled) update.current(result.assets); } catch (err) { if (!cancelled) setError(errorMessage(err)); } }
    void load(); const timer = setInterval(() => void load(), 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session]);
  const working = object && sessionAssets.some((asset) => asset.object_id === object.id && ["QUEUED", "RUNNING"].includes(asset.status));
  async function reconstruct() {
    if (!session || !object) return;
    setPending(true); setError("");
    try {
      await faultline<ObjectAssetJob>("assets/reconstruct", { session, body: { session_id: session.session_id, object_id: object.id, ...(knownFootprint ? { physical_footprint_m: [Number(widthCm) / 100, Number(depthCm) / 100] } : {}) } });
      await refresh();
    } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  }
  return <section aria-label="Object reconstruction" style={{ borderTop: "1px solid #d8ddd1", paddingTop: 14, marginTop: 14 }}>
    <h3 style={{ fontSize: 14, fontWeight: 550, margin: "0 0 7px" }}>Reconstruct an object</h3>
    <p className="fl-caption">Create a Hyper3D mesh from the selected object's latest camera crop. This sends that crop to Hyper3D when you choose Reconstruct.</p>
    <label className="fl-field">Visible camera object<select value={object?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)} disabled={pending}><option value="" disabled>Track an object in the camera first</option>{objects.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.id}</option>)}</select></label>
    {object && <p className="fl-caption">Object dimensions: {object.dimensions.map((value) => value.toFixed(3)).join(" × ")} {observed?.coordinate_frame === "workcell_m" ? "m" : "workspace units"}. {object.measured_fields.includes("dimensions") ? "Measured dimensions" : "Declared dimensions"} set mesh scale. Tracked position and orientation place the visual in the workcell.</p>}
    <label className="fl-checkbox"><input type="checkbox" checked={knownFootprint} disabled={pending || !!working} onChange={(event) => setKnownFootprint(event.target.checked)} /><span>Use known footprint</span></label>
    {knownFootprint && <div><div className="fl-two-fields"><label className="fl-field">Width (cm)<input type="number" min="0.1" max="1000" step="0.1" value={widthCm} disabled={pending || !!working} onChange={(event) => setWidthCm(event.target.value)} /></label><label className="fl-field">Depth (cm)<input type="number" min="0.1" max="1000" step="0.1" value={depthCm} disabled={pending || !!working} onChange={(event) => setDepthCm(event.target.value)} /></label></div><div className="fl-toolbar"><button type="button" className="fl-text-link" disabled={pending || !!working} onClick={() => { setWidthCm("14"); setDepthCm("4"); }}>Chocolate 14 × 4 cm</button><button type="button" className="fl-text-link" disabled={pending || !!working} onClick={() => { setWidthCm("6"); setDepthCm("10"); }}>Blue 6 × 10 cm</button></div><p className="fl-caption">Known width and depth set the visual footprint. Height remains declared. {observed?.coordinate_frame === "workcell_m" ? "The calibrated workspace supports metric placement." : "Without metric calibration, the footprint corrects relative shape only; absolute scale is not measured."}</p>{!footprintValid && <p className="fl-error">Enter positive width and depth, up to 1000 cm.</p>}</div>}
    <button type="button" className="fl-button fl-button-secondary" disabled={!session || !object || pending || !!working || (knownFootprint && !footprintValid)} onClick={() => void reconstruct()}>{pending ? "Submitting crop…" : working ? "Reconstruction in progress…" : "Reconstruct selected object"}</button>
    {error && <p className="fl-error" role="alert">{error}</p>}
    {sessionAssets.map((asset) => <div key={asset.job_id} style={{ padding: "12px 0", borderBottom: "1px solid #e4e9df" }}><strong style={{ fontSize: 12, fontWeight: 550 }}>{asset.object_id} · {asset.status === "SUCCEEDED" ? "Mesh ready" : asset.status === "FAILED" ? "Reconstruction failed" : asset.status === "RUNNING" ? "Generating mesh" : "Queued"}</strong><p className="fl-caption" style={{ margin: "5px 0" }}>{asset.scale_source === "measured_footprint_relative" ? "Known footprint · relative shape · declared height" : asset.scale_source === "measured_footprint" ? "Measured footprint · declared height" : asset.scale_source === "measured_dimensions" ? "Measured dimensions" : "Declared dimensions"} · {asset.dimensions.map((value) => value.toFixed(3)).join(" × ")} {asset.scale_source === "measured_footprint_relative" ? "workspace units" : observed?.coordinate_frame === "workcell_m" ? "m" : "workspace units"}{asset.physical_footprint_m ? ` · supplied footprint ${asset.physical_footprint_m.map((value) => (value * 100).toFixed(1)).join(" × ")} cm` : ""} · crop {asset.input_frame_ref ?? "not reported"}{asset.progress !== null && asset.progress !== undefined ? ` · ${typeof asset.progress === "number" ? "progress " : ""}${asset.progress}` : ""}</p>{asset.error && <p className="fl-error">{asset.error}</p>}{asset.status === "SUCCEEDED" && asset.model_url && <a className="fl-text-link" href={asset.model_url} download>Download reconstructed GLB</a>}</div>)}
    <p className="fl-caption">The mesh changes appearance only. Collision geometry, tracked poses and test evaluation keep using the existing scene state. Unavailable meshes retain the object bounds.</p>
  </section>;
}
