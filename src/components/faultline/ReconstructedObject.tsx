"use client";
import { useLoader } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Vec3 } from "@/lib/faultline";
import type { ObjectAssetJob } from "./world-view";

class AssetBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError?: (reason: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError?.(error.message || "Reconstructed mesh could not load."); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function LoadedObject({ url, dimensions, visible }: { url: string; dimensions: Vec3; visible: boolean }) {
  const gltf = useLoader(GLTFLoader, url);
  const normalized = useMemo(() => {
    // GLB uses Y up. The warehouse viewer also uses Y up; caller already maps
    // backend Z-up dimensions to [width, height, depth] and applies object pose.
    // Image reconstruction has no metric scale, so fit each axis to the user's
    // existing declared/measured object bounds. This is a visual only operation.
    const scene = gltf.scene.clone(true);
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(scene);
    const extent = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    if ([extent.x, extent.y, extent.z].some((value) => !Number.isFinite(value) || value <= 1e-8)) throw new Error("Reconstructed mesh has invalid bounds.");
    const offset = new THREE.Group(); offset.add(scene); scene.position.sub(center);
    const fitted = new THREE.Group(); fitted.add(offset);
    fitted.scale.set(dimensions[0] / extent.x, dimensions[1] / extent.y, dimensions[2] / extent.z);
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true; child.receiveShadow = true;
      const source = Array.isArray(child.material) ? child.material : [child.material];
      const materials = source.map((material) => { const copy = material.clone(); copy.transparent = !visible || material.transparent; copy.opacity = visible ? material.opacity : .25; return copy; });
      child.material = Array.isArray(child.material) ? materials : materials[0]!;
    });
    return fitted;
  }, [gltf.scene, dimensions[0], dimensions[1], dimensions[2], visible]);
  useEffect(() => () => {
    normalized.traverse((child) => {
      if (child instanceof THREE.Mesh) (Array.isArray(child.material) ? child.material : [child.material]).forEach((material) => material.dispose());
    });
  }, [normalized]);
  return <primitive object={normalized} dispose={null} userData={{ visualOnly: true, scaleSource: "existing_object_dimensions", coordinateConvention: "GLB Y-up to viewer Y-up; external object pose maps backend Z-up" }} />;
}

export function ReconstructedObject({ asset, dimensions, visible, fallback, onError }: { asset: ObjectAssetJob; dimensions: Vec3; visible: boolean; fallback: ReactNode; onError?: (reason: string) => void }) {
  const url = asset.model_url;
  // Only fetch the backend-owned model for this exact persisted asset job.
  const expected = `/api/faultline/assets/${encodeURIComponent(asset.job_id)}/model.glb`;
  if (asset.status !== "SUCCEEDED" || !url || url !== expected || dimensions.some((value) => !Number.isFinite(value) || value <= 0)) return <>{fallback}</>;
  return <AssetBoundary key={asset.job_id} fallback={fallback} onError={onError}><Suspense fallback={fallback}><LoadedObject url={url} dimensions={dimensions} visible={visible} /></Suspense></AssetBoundary>;
}
