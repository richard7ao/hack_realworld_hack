import type { ObservedScene, SimWorld } from "@/lib/faultline";

export type ObjectAssetJob = {
  job_id: string; object_id: string; camera_session: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  dimensions: [number, number, number]; scale_source: "declared_dimensions" | "measured_dimensions" | "measured_footprint" | "measured_footprint_relative";
  physical_footprint_m?: [number, number] | null;
  input_frame_ref: string | null; bbox: [number, number, number, number] | null;
  model_url?: string | null; error?: string | null; provider: "hyper3d"; progress?: string | number | null;
};

export type WorldProps = {
  world: SimWorld | null;
  visualAssets?: ObjectAssetJob[];
  cameraSessionId?: string;
  observed?: ObservedScene;
  targetId: string;
  source?: string;
  cinematicDefault?: boolean;
  provenance?: string | Record<string, unknown>;
};

export function sceneProvenance({ world, observed, source, provenance }: WorldProps) {
  const explicit = source ?? (typeof provenance === "string" ? provenance : typeof provenance?.source === "string" ? provenance.source : "");
  const mode = typeof provenance === "object" ? String(provenance.run_mode ?? "") : "";
  const execution = typeof provenance === "object" ? String(provenance.execution_backend ?? "") : "";
  if (execution === "robosimstudio_cpu" || world?.robot.kinematics_kind === "robosim_physics") return {
    label: mode === "recorded_trace" ? "ROBOSIM NATIVE PHYSICS TRACE" : mode === "scenario_preview" ? "ROBOSIM PHYSICS · SCENE READY" : "ROBOSIM NATIVE PHYSICS",
    detail: "Declared scene · actual native poses · no physical depth capture",
  };
  if (/procedural/i.test(explicit) || (!explicit && observed?.sensor_mode === "PROCEDURAL")) return { label: "PROCEDURAL SIMULATION", detail: "Declared scenario geometry · simulated actions" };
  if (/scenario_rerun|captured.*rerun|captured.*replay/i.test(explicit) || mode === "scenario_rerun") return { label: "CAPTURED SCENARIO RERUN", detail: "Saved scene geometry · fresh simulated execution" };
  if (/operator/i.test(explicit)) return { label: "OPERATOR-DEFINED SIMULATION", detail: "Declared scene geometry · labelled virtual disturbance" };
  if (mode === "live_capture") return { label: "LIVE RGB ESTIMATES", detail: "Planar RGB estimates · declared object heights" };
  if (/captured_live_rgb/i.test(explicit)) return { label: "CAPTURED RGB SCENE", detail: "Planar RGB estimates · declared object heights" };
  if (/live|rgb|camera|desk_view/i.test(explicit) || (!world && observed?.sensor_mode === "RGB")) return { label: "LIVE RGB ESTIMATES", detail: "Planar RGB estimates · declared object heights" };
  return { label: world ? "SIMULATED SCENE" : "AWAITING SCENE", detail: "Backend geometry · no physical depth measurement" };
}
