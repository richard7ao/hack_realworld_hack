"use client";
import dynamic from "next/dynamic";
import { Component, useEffect, useState, type ReactNode } from "react";
import type { Vec3 } from "@/lib/faultline";
import { sceneProvenance, type WorldProps } from "./world-view";
import "./warehouse-viewer.css";

const Warehouse3D = dynamic(() => import("./Warehouse3D"), { ssr: false, loading: () => <div className="fl3-loading">Loading 3D warehouse…</div> });
class ViewerBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
export function World(props: WorldProps) {
  const [view, setView] = useState<"3d" | "plan">("plan");
  const [available, setAvailable] = useState<boolean | null>(null);
  const provenance = sceneProvenance(props);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    let capable = false;
    try { const context = canvas.getContext("webgl2"); capable = !!context; context?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* Keep an executable SVG view if WebGL cannot start. */ }
    setAvailable(capable);
    if (capable && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) setView("3d");
  }, []);
  const fallback = <><div className="fl3-fallback-note">3D unavailable in this browser. Showing exact backend geometry in the plan view.</div><PlanWorld {...props} /></>;
  const robot = props.world?.robot as (NonNullable<WorldProps["world"]>["robot"] & { kinematics_kind?: string; joint_angles?: number[] | null }) | undefined;
  return <div className="fl3-viewer">
    <div className="fl3-toolbar"><div><span>{provenance.label}</span><small>{provenance.detail}</small></div><div className="fl3-tabs" role="group" aria-label="Warehouse view"><button type="button" aria-pressed={view === "3d"} disabled={available === false} onClick={() => setView("3d")}>3D</button><button type="button" aria-pressed={view === "plan"} onClick={() => setView("plan")}>Plan</button></div></div>
    {view === "3d" && available ? <ViewerBoundary fallback={fallback}><Warehouse3D {...props} /><div className="fl-world-footer"><span>{props.world ? `Action ${props.world.step} · ${(props.world.sim_elapsed_ms / 1000).toFixed(1)}s simulated` : `${props.observed?.objects.length ?? 0} objects estimated`}</span><span>{robot?.holding_id ? `Held: ${robot.holding_id}` : robot?.kinematics_kind === "six_dof_kinematic" ? "6 DOF · backend forward kinematics" : "Cartesian gantry · backend pose"}</span></div></ViewerBoundary> : <PlanWorld {...props} />}
    {robot?.joint_angles?.length === 6 && <div className="fl3-joints" aria-label="Actual robot joint angles">{robot.joint_angles.map((angle, i) => <span key={i}>J{i + 1} {(angle * 180 / Math.PI).toFixed(1)}°</span>)}</div>}
  </div>;
}

const COLORS = ["#a5cb59", "#a899d5", "#d8a35e", "#76b3bf", "#c98da1"];
function PlanWorld(props: WorldProps) {
  const { world, observed, targetId } = props;
  const provenance = sceneProvenance(props);
  const workspace = world?.workspace ?? observed?.workspace ?? [1, 1];
  const objects = world?.objects ?? observed?.objects ?? [];
  const unit = Math.max(workspace[0], workspace[1]);
  const project = (v: Vec3): [number, number] => [425 + (v[0] / workspace[0] - v[1] / workspace[1]) * 270, 140 + (v[0] / workspace[0] + v[1] / workspace[1]) * 130 - v[2] / unit * 330];
  const points = (vs: Vec3[]) => vs.map((p) => project(p).join(",")).join(" ");
  const line = (a: Vec3, b: Vec3) => ({ x1: project(a)[0], y1: project(a)[1], x2: project(b)[0], y2: project(b)[1] });
  function box(id: string, center: Vec3, size: Vec3, color: string, label?: string, selected = false, opacity = 1, yaw = 0) {
    const [x, y, z] = center; const [w, d, h] = size;
    const vertex = (dx: number, dy: number): Vec3 => [x + dx * Math.cos(yaw) - dy * Math.sin(yaw), y + dx * Math.sin(yaw) + dy * Math.cos(yaw), z + h / 2];
    const a = vertex(-w / 2, -d / 2);
    const b = vertex(w / 2, -d / 2);
    const c = vertex(w / 2, d / 2);
    const e = vertex(-w / 2, d / 2);
    const low = (v: Vec3): Vec3 => [v[0], v[1], z - h / 2];
    const labelAt = project([x, y, z + h / 2]);
    return <g key={id} opacity={opacity}>
      <polygon points={points([e, c, low(c), low(e)])} fill={color} stroke="#334137" strokeWidth="1" />
      <polygon points={points([b, c, low(c), low(b)])} fill={color} style={{ filter: "brightness(.8)" }} stroke="#334137" strokeWidth="1" />
      <polygon points={points([a, b, c, e])} fill={color} style={{ filter: "brightness(1.15)" }} stroke={selected ? "#336138" : "#334137"} strokeWidth={selected ? 3 : 1} />
      {label && <text x={labelAt[0]} y={labelAt[1] - 12} textAnchor="middle" fill="#26332a" fontSize="12" fontWeight={600} stroke="#f7f8f3" strokeWidth="3" paintOrder="stroke">{label}</text>}
    </g>;
  }
  const robot = world?.robot as (NonNullable<WorldProps["world"]>["robot"] & { kinematics_kind?: string; link_positions?: Vec3[] | null }) | undefined;
  const chain = robot?.kinematics_kind === "six_dof_kinematic" ? robot.link_positions : null;
  return <div className="fl-world-wrap">
    <svg viewBox="0 0 850 480" className="fl-world" role="img" aria-label={world ? `Backend world, ${world.state}, ${world.step} executed actions` : "Observed camera estimates awaiting simulation"}>
      <defs><pattern id="fl-floor" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#d8dfd4" /></pattern></defs>
      <rect width="850" height="480" fill="#f2f5ed" />
      <rect width="850" height="480" fill="url(#fl-floor)" />
      <polygon points={points([[0, 0, 0], [workspace[0], 0, 0], [workspace[0], workspace[1], 0], [0, workspace[1], 0]])} fill="#e0e5da" stroke="#76836e" strokeWidth="2" />
      {[.25, .5, .75].map((v) => <g key={v} stroke="#bbc6b4" strokeWidth="1"><line {...line([workspace[0] * v, 0, 0], [workspace[0] * v, workspace[1], 0])} /><line {...line([0, workspace[1] * v, 0], [workspace[0], workspace[1] * v, 0])} /></g>)}
      {world && box("destination", [world.destination.center[0], world.destination.center[1], .008 * unit], [world.destination.size[0], world.destination.size[1], .016 * unit], "#b7cf9d", "OUTBOUND")}
      {world?.obstacles.map((o) => box(o.id, o.center, o.size, "#cf8073", o.id))}
      {[...objects].sort((a, b) => a.position[0] + a.position[1] - b.position[0] - b.position[1]).map((o, i) => box(o.id, o.position, o.dimensions, COLORS[i % COLORS.length]!, o.id + (!o.visible ? " · uncertain" : ""), o.id === targetId, o.visible ? 1 : .35, o.yaw_rad))}
      {robot && <g>
        {chain && chain.length > 1 ? chain.map((joint, index) => <g key={index}>{index > 0 && <line {...line(chain[index - 1]!, joint)} stroke={index % 2 ? "#8b9f68" : "#4a5c47"} strokeWidth="10" strokeLinecap="round" />}<circle cx={project(joint)[0]} cy={project(joint)[1]} r="6" fill="#50654b" /></g>) : <><line {...line([0, 0, .52 * unit], [workspace[0], 0, .52 * unit])} stroke="#4a5650" strokeWidth="11" strokeLinecap="round" />
        <line {...line([robot.position[0], 0, .52 * unit], [robot.position[0], workspace[1], .52 * unit])} stroke="#66756b" strokeWidth="8" strokeLinecap="round" />
        <line {...line([robot.position[0], robot.position[1], .52 * unit], robot.position)} stroke="#334137" strokeWidth="7" /></>}
        <circle cx={project(robot.position)[0]} cy={project(robot.position)[1]} r="9" fill={robot.holding_id ? "#336138" : "#fff"} stroke="#26332a" strokeWidth="3" />
        <path d={`M${project(robot.position)[0] - 12},${project(robot.position)[1] - 3}v15m24,-15v15`} fill="none" stroke="#26332a" strokeWidth="4" />
      </g>}
      <text x="24" y="32" fill="#44513e" fontSize="12" fontFamily="monospace">{world ? `SIMULATOR · ${world.state} · v${world.version}` : "OBSERVED ESTIMATES · AWAITING RUN"}</text>
      <text x="24" y="454" fill="#44513e" fontSize="12" fontFamily="monospace">{world?.coordinate_frame === "workcell_m" || observed?.coordinate_frame === "workcell_m" ? "METRES ·" : "NORMALIZED UNITS ·"} {provenance.label}</text>
    </svg>
    <div className="fl-world-footer"><span>{world ? `Action ${world.step} · ${(world.sim_elapsed_ms / 1000).toFixed(1)}s simulated` : `${objects.length} objects estimated`}</span><span>{robot?.holding_id ? `Held: ${robot.holding_id} · simulator authority` : chain ? "6 DOF · backend forward kinematics" : "Virtual Cartesian gripper"}</span></div>
  </div>;
}
