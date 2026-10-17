"use client";
import { useLoader } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

/** Authoritative mesh-world pose, including MJCF geom-local translation/rotation. */
export type YamMeshPose = {
  name: string;
  mesh: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
};
export type YamRobotProps = {
  meshPoses: readonly YamMeshPose[];
  /** The caller can show the same backend's exact link-capsule geometry while loading. */
  fallback?: ReactNode;
  onError?: (reason: string) => void;
};

const MESH_NAMES = ["base", "link1", "link2", "link3", "link4", "link5", "gripper", "tip_left", "tip_right"] as const;
const FILES = MESH_NAMES.map((name) => `/robots/yam_i2rt/${name}.stl`);
const UPSTREAM_COMMIT = "73739abe212f963e8a9f5862b27bca370df091a7";

class MeshBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError?: (reason: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError?.(`YAM mesh rendering: ${error.message}`); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function meshIndex(pose: YamMeshPose): number {
  const file = pose.mesh.split("/").at(-1)?.replace(/\.stl$/i, "");
  const index = MESH_NAMES.findIndex((name) => name === file);
  if (index < 0) throw new Error(`Unsupported YAM mesh ${pose.mesh}; the asset allowlist contains exactly nine meshes.`);
  if (pose.position.length !== 3 || pose.quaternion.length !== 4 || ![...pose.position, ...pose.quaternion].every(Number.isFinite)) {
    throw new Error(`Invalid backend mesh pose for ${pose.name}`);
  }
  const norm = Math.hypot(...pose.quaternion);
  if (Math.abs(norm - 1) > .001) throw new Error(`Backend mesh quaternion is not a unit quaternion for ${pose.name}`);
  return index;
}

function YamMeshes({ meshPoses }: { meshPoses: readonly YamMeshPose[] }) {
  const geometries = useLoader(STLLoader, FILES);
  const materials = useMemo(() => ({
    white: new THREE.MeshStandardMaterial({ name: "FAULTLINE white presentation override", color: "#e8ece7", roughness: .29, metalness: .38 }),
    graphite: new THREE.MeshStandardMaterial({ name: "FAULTLINE graphite presentation override", color: "#333d38", roughness: .34, metalness: .58 }),
    gripper: new THREE.MeshStandardMaterial({ name: "FAULTLINE gripper presentation override", color: "#748176", roughness: .35, metalness: .68 }),
  }), []);
  useEffect(() => () => { Object.values(materials).forEach((material) => material.dispose()); }, [materials]);
  return <group name="RoboSimStudio I2RT YAM imported geometry" userData={{
    source: "https://github.com/robosimstudio/robosimstudio", commit: UPSTREAM_COMMIT,
    assetLicense: "MIT · Copyright (c) I2RT Robotics", upstreamProjectLicense: "Apache-2.0",
    materialOverride: "FAULTLINE white/graphite presentation; upstream geometry unchanged",
    coordinateContract: "backend world XYZ metres, Z up; quaternion XYZW includes MJCF geom-local transform",
  }}>
    {meshPoses.map((pose) => {
      const index = meshIndex(pose);
      const name = MESH_NAMES[index]!;
      const material = name === "gripper" ? materials.gripper : ["link1", "link4", "tip_left", "tip_right"].includes(name) ? materials.graphite : materials.white;
      return <mesh key={pose.name} name={pose.name} geometry={geometries[index]} material={material}
        position={pose.position} quaternion={pose.quaternion} castShadow receiveShadow dispose={null}
        userData={{ mesh: name, poseSource: "backend.robot.mesh_poses", geometryModified: false }} />;
    })}
  </group>;
}

/**
 * Real upstream STL vertices, placed only by backend mesh poses. No local IK,
 * centering, rescaling, joint animation, or MJCF origin reconstruction is done.
 * The caller applies the scene's single metres/Z-up -> viewer transform outside.
 */
export function YamRobot({ meshPoses, fallback = null, onError }: YamRobotProps) {
  if (!meshPoses.length) return <>{fallback}</>;
  return <MeshBoundary fallback={fallback} onError={onError}>
    <Suspense fallback={fallback}><YamMeshes meshPoses={meshPoses} /></Suspense>
  </MeshBoundary>;
}
export default YamRobot;
