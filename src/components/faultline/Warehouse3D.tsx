"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SimWorld, Vec3, Zone } from "@/lib/faultline";
import type { WorldProps } from "./world-view";
import { YamRobot } from "./YamRobot";

type CameraShot = "overview" | "robot" | "target" | "top";
type ControlsHandle = { preset: (shot: CameraShot) => void; reset: () => void; top: () => void; zoom: (factor: number) => void };
type RobotGeometry = SimWorld["robot"] & { kinematics_kind?: string; joint_angles?: number[] | null; link_positions?: Vec3[] | null };
const COLORS = ["#aa804e", "#b49b68", "#8b9c71", "#a78e79", "#c49f65", "#929eaf"];
function Box({ at, size, color, opacity = 1, roughness = .65, metalness = 0, edges = false }: { at: Vec3; size: Vec3; color: string; opacity?: number; roughness?: number; metalness?: number; edges?: boolean }) {
  const geometry = useMemo(() => new THREE.BoxGeometry(...size), [size[0], size[1], size[2]]);
  const outline = useMemo(() => edges ? new THREE.EdgesGeometry(geometry) : null, [geometry, edges]);
  useEffect(() => () => { geometry.dispose(); outline?.dispose(); }, [geometry, outline]);
  return <group position={at}><mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial color={color} roughness={roughness} metalness={metalness} transparent={opacity < 1} opacity={opacity} depthWrite={opacity > .5} /></mesh>{outline && <lineSegments geometry={outline}><lineBasicMaterial color="#374638" transparent opacity={.6 * opacity} /></lineSegments>}</group>;
}
function Label({ at, text }: { at: Vec3; text: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 80;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f8fff0"; context.strokeStyle = "#708b5c"; context.lineWidth = 2;
    context.beginPath(); context.roundRect(4, 4, 504, 72, 10); context.fill(); context.stroke();
    context.fillStyle = "#314a27"; context.font = "500 25px monospace"; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(text.slice(0, 30), 256, 41, 480);
    const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
    return map;
  }, [text]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <sprite position={at} scale={[1.5, .235, 1]}><spriteMaterial map={texture} depthTest={false} transparent /></sprite>;
}
function Link({ start, end, radius, color, industrial = false }: { start: Vec3; end: Vec3; radius: number; color: string; industrial?: boolean }) {
  const a = new THREE.Vector3(...start); const b = new THREE.Vector3(...end); const delta = b.clone().sub(a);
  if (delta.length() < .00001) return null;
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize());
  const length = delta.length();
  return <group position={a.add(b).multiplyScalar(.5)} quaternion={quaternion}>
    <mesh castShadow receiveShadow><cylinderGeometry args={[radius * .8, radius, length, industrial ? 20 : 12]} /><meshStandardMaterial color={color} metalness={industrial ? .55 : .45} roughness={.33} /></mesh>
    {industrial && <>
      <Box at={[0, 0, radius * .78]} size={[radius * .85, Math.max(.02, length * .6), radius * .28]} color="#d9dfc7" metalness={.55} roughness={.32} />
      {[-1, 1].map((side) => <mesh key={side} position={[0, side * Math.max(0, length / 2 - radius * .22), 0]}><cylinderGeometry args={[radius * 1.1, radius * 1.1, radius * .3, 24]} /><meshStandardMaterial color="#354a42" metalness={.8} roughness={.28} /></mesh>)}
    </>}
  </group>;
}
function Controls({ handle, extent, centerY, revision, robotFocus, targetFocus, cinematic, reducedMotion, onManual, onShot }: {
  handle: RefObject<ControlsHandle | null>; extent: number; centerY: number; revision: string;
  robotFocus: Vec3 | null; targetFocus: Vec3 | null; cinematic: boolean; reducedMotion: boolean;
  onManual: () => void; onShot: (shot: CameraShot) => void;
}) {
  const { camera, gl, invalidate } = useThree();
  const orbit = useRef<OrbitControls | null>(null);
  const transition = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const live = useRef({ robotFocus, targetFocus, cinematic, reducedMotion, onManual, onShot });
  live.current = { robotFocus, targetFocus, cinematic, reducedMotion, onManual, onShot };
  const cycle = useRef({ index: 0, started: 0 });
  const desired = useCallback((shot: CameraShot, drift = 0) => {
    const focus = shot === "robot" ? live.current.robotFocus : shot === "target" ? live.current.targetFocus : null;
    const target = focus ? new THREE.Vector3(...focus) : new THREE.Vector3(0, centerY, 0);
    const offsets: Record<CameraShot, Vec3> = {
      overview: [extent * (.92 + drift), extent * .72, extent * (1.05 - drift)],
      robot: [extent * (.44 + drift), extent * .36, extent * .52],
      target: [extent * (.34 + drift), extent * .44, extent * .42],
      top: [0, extent * 1.5, .001],
    };
    return { position: target.clone().add(new THREE.Vector3(...offsets[shot])), target };
  }, [extent, centerY]);
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement); orbit.current = controls;
    controls.enableDamping = false; controls.minDistance = extent * .2; controls.maxDistance = extent * 4;
    controls.maxPolarAngle = Math.PI * .485;
    const change = () => invalidate();
    const manual = () => { transition.current = null; live.current.cinematic = false; live.current.onManual(); };
    controls.addEventListener("change", change); controls.addEventListener("start", manual);
    const applyPreset = (shot: CameraShot) => {
      live.current.onManual(); live.current.onShot(shot);
      const view = desired(shot);
      if (live.current.reducedMotion) { camera.position.copy(view.position); controls.target.copy(view.target); controls.update(); }
      else transition.current = view;
      invalidate();
    };
    handle.current = {
      preset: applyPreset,
      reset: () => applyPreset("overview"), top: () => applyPreset("top"),
      zoom: (factor) => { manual(); camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target); controls.update(); invalidate(); },
    };
    const initial = desired("overview"); camera.position.copy(initial.position); controls.target.copy(initial.target); controls.update(); invalidate();
    return () => { handle.current = null; orbit.current = null; controls.removeEventListener("change", change); controls.removeEventListener("start", manual); controls.dispose(); };
  }, [camera, gl, invalidate, extent, revision, handle, desired]);
  useEffect(() => {
    if (cinematic && !reducedMotion) { cycle.current = { index: 0, started: performance.now() }; transition.current = null; onShot("overview"); invalidate(); }
  }, [cinematic, reducedMotion, invalidate, onShot]);
  useFrame((_, delta) => {
    const controls = orbit.current; if (!controls) return;
    if (live.current.cinematic && !live.current.reducedMotion) {
      const shots: CameraShot[] = ["overview", "robot", "target", "overview"];
      const now = performance.now();
      if (now - cycle.current.started > 8500) { cycle.current.index = (cycle.current.index + 1) % shots.length; cycle.current.started = now; live.current.onShot(shots[cycle.current.index]!); }
      const view = desired(shots[cycle.current.index]!, Math.sin((now - cycle.current.started) / 8500 * Math.PI) * .08);
      const alpha = 1 - Math.exp(-Math.min(delta, .08) * .75);
      camera.position.lerp(view.position, alpha); controls.target.lerp(view.target, alpha); controls.update(); invalidate();
    } else if (transition.current) {
      const alpha = 1 - Math.exp(-Math.min(delta, .08) * 4.2);
      camera.position.lerp(transition.current.position, alpha); controls.target.lerp(transition.current.target, alpha); controls.update();
      if (camera.position.distanceTo(transition.current.position) < .005 && controls.target.distanceTo(transition.current.target) < .005) transition.current = null;
      else invalidate();
    }
  });
  return null;
}
function RendererMonitor({ onReady, onUnavailable }: { onReady: (evidence: { frames: number; drawCalls: number }) => void; onUnavailable: (reason: string) => void }) {
  const { gl, invalidate } = useThree();
  const reported = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const lost = (event: Event) => { event.preventDefault(); onUnavailable("The active WebGL context was lost while rendering."); };
    const failed = (event: Event) => onUnavailable((event as WebGLContextEvent).statusMessage || "The renderer could not create its WebGL context.");
    gl.domElement.addEventListener("webglcontextlost", lost);
    gl.domElement.addEventListener("webglcontextcreationerror", failed);
    return () => { mounted.current = false; gl.domElement.removeEventListener("webglcontextlost", lost); gl.domElement.removeEventListener("webglcontextcreationerror", failed); };
  }, [gl, onUnavailable]);
  useFrame(() => {
    if (reported.current) return;
    if (gl.getContext().isContextLost()) { reported.current = true; queueMicrotask(() => mounted.current && onUnavailable("The active WebGL context was lost before its first frame.")); return; }
    // useFrame runs before drawing: these counters come from the preceding
    // completed render, not an assumption that canvas creation was enough.
    if (gl.info.render.frame > 0 && gl.info.render.calls > 0) {
      reported.current = true;
      const evidence = { frames: gl.info.render.frame, drawCalls: gl.info.render.calls };
      queueMicrotask(() => mounted.current && onReady(evidence));
    } else invalidate();
  });
  return null;
}
function Scene({ world, observed, targetId, controls, cinematic, reducedMotion, onManual, onShot, showColliders }: WorldProps & {
  controls: RefObject<ControlsHandle | null>; cinematic: boolean; reducedMotion: boolean;
  onManual: () => void; onShot: (shot: CameraShot) => void; showColliders: boolean;
}) {
  const workspace = world?.workspace ?? observed?.workspace ?? [1, 1];
  const [width, depth] = workspace;
  const scale = 6 / Math.max(width, depth);
  const size = (v: Vec3): Vec3 => [v[0] * scale, v[2] * scale, v[1] * scale];
  const point = (v: Vec3): Vec3 => [(v[0] - width / 2) * scale, v[2] * scale, (v[1] - depth / 2) * scale];
  const W = width * scale; const D = depth * scale;
  const objects = world?.objects ?? observed?.objects ?? [];
  const robot = world?.robot as RobotGeometry | undefined;
  const extent = Math.max(W, D);
  const post = .055;
  const nativeRobot = robot?.kinematics_kind === "robosim_physics";
  const yamVisual = nativeRobot && robot.visual_model_id === "yam_i2rt" && !!robot.mesh_poses?.length;
  const articulated = ["six_dof_kinematic", "robosim_physics"].includes(robot?.kinematics_kind ?? "") && robot?.link_positions && robot.link_positions.length > 1;
  // One complete backend XYZ/Z-up -> existing viewer XYZ/Y-up mapping. This
  // reflection matches every object, floor and collider; no mesh-local origin
  // is replayed here because backend mesh_poses already includes it.
  const nativeTransform = new THREE.Matrix4().set(
    scale, 0, 0, -width / 2 * scale,
    0, 0, scale, 0,
    0, scale, 0, -depth / 2 * scale,
    0, 0, 0, 1,
  );
  const gantryHeight = Math.max(1.9, extent * .55);
  const highest = Math.max(gantryHeight, ...(world?.obstacles.map((o) => (o.center[2] + o.size[2] / 2) * scale) ?? [0]));
  const robotFocus: Vec3 | null = articulated ? point([0, 1, 2].map((axis) => (Math.min(...robot!.link_positions!.map((joint) => joint[axis]!)) + Math.max(...robot!.link_positions!.map((joint) => joint[axis]!))) / 2) as Vec3) : robot ? point(robot.position) : null;
  function obstacle(zone: Zone) {
    const [w, h, d] = size(zone.size); const [x, y, z] = point(zone.center);
    const isRack = /rack|shelv/i.test(zone.id) || h > .8;
    if (!isRack) return <Box key={zone.id} at={[x, y, z]} size={[w, h, d]} color="#9a7762" edges />;
    const thickness = Math.min(.065, w * .08, d * .08);
    const bays = Math.max(1, Math.min(4, Math.floor(w / .8)));
    const shelves = [0, .34, .67, .97];
    return <group key={zone.id} position={[x, y, z]}>
      {showColliders && <Box at={[0, 0, 0]} size={[w, h, d]} color="#d29c45" opacity={.08} edges />}
      {Array.from({ length: bays + 1 }, (_, bay) => [-1, 1].map((side) => <group key={`${bay}-${side}`}>
        <Box at={[-w / 2 + thickness / 2 + (w - thickness) * bay / bays, 0, side * (d - thickness) / 2]} size={[thickness, h, thickness]} color="#40564f" metalness={.72} roughness={.38} />
        {Array.from({ length: 8 }, (_, i) => <Box key={i} at={[-w / 2 + thickness / 2 + (w - thickness) * bay / bays, -h / 2 + h * (i + 1) / 9, side * (d - thickness) / 2 + side * .004]} size={[thickness * .3, thickness * .25, thickness * 1.15]} color="#263e35" />)}
      </group>))}
      {shelves.map((v) => <group key={v} position={[0, -h / 2 + h * v + thickness / 2, 0]}>
        {[-1, 1].map((side) => <Box key={side} at={[0, 0, side * (d - thickness) / 2]} size={[w, thickness * 1.25, thickness]} color="#be8e4e" metalness={.5} roughness={.46} />)}
        <Box at={[0, thickness * .3, 0]} size={[w - thickness, thickness * .32, d - thickness]} color="#a9b4a5" metalness={.6} roughness={.55} />
        {Array.from({ length: bays - 1 }, (_, bay) => <Box key={bay} at={[-w / 2 + w * (bay + 1) / bays, 0, 0]} size={[thickness, thickness, d]} color="#83917f" metalness={.6} />)}
      </group>)}
      {[-1, 1].map((side) => <Link key={side} start={[-w / 2 + thickness / 2, -h * .45, side * (d - thickness) / 2]} end={[w / 2 - thickness / 2, h * .45, side * (d - thickness) / 2]} radius={thickness * .17} color="#718674" />)}
    </group>;
  }
  return <>
    <color attach="background" args={[nativeRobot ? "#deded8" : "#e5ebe0"]} />
    <fog attach="fog" args={[nativeRobot ? "#deded8" : "#e5ebe0", 15, 45]} />
    <ambientLight intensity={.75} />
    <hemisphereLight args={[nativeRobot ? "#fffaf2" : "#fbfff4", nativeRobot ? "#737773" : "#77806d", 1.5]} />
    <directionalLight position={[4, 10, 5]} intensity={2.8} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-6} shadow-camera-right={6} shadow-camera-top={6} shadow-camera-bottom={-6} shadow-camera-far={30} shadow-normalBias={.035} />
    <directionalLight position={[-6, 5, -4]} intensity={.7} color="#cdddc2" />
    {nativeRobot ? <>
      {/* RoboSim's bench_075 is a solid bench, 0.75m tall, with the backend's
          exact tabletop footprint. The floor below it is presentation scenery. */}
      <Box at={[0, -.375 * scale, 0]} size={[W, .75 * scale, D]} color="#69716b" roughness={.65} metalness={.22} />
      <Box at={[0, -.014, 0]} size={[W, .028, D]} color="#c1c5be" roughness={.48} metalness={.35} />
      {[-1, 1].map((side) => <Box key={side} at={[side * (W / 2 - .06), -.75 * scale + .035, 0]} size={[.1, .07, D - .08]} color="#3a443e" metalness={.65} />)}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.75 * scale - .005, 0]} receiveShadow><planeGeometry args={[extent * 4, extent * 4]} /><meshStandardMaterial color="#b5b9b1" roughness={.92} /></mesh>
      <gridHelper args={[extent * 4, 24, "#a4aaa0", "#adb3a8"]} position={[0, -.75 * scale, 0]} />
    </> : <>
      <Box at={[0, -.12, 0]} size={[W + .2, .24, D + .2]} color="#d6dcd0" roughness={.94} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.245, 0]} receiveShadow><planeGeometry args={[extent * 3, extent * 3]} /><meshStandardMaterial color="#e4e9de" roughness={1} /></mesh>
      <gridHelper args={[extent * 3, 36, "#c7d0bc", "#d4dccb"]} position={[0, -.239, 0]} />
    </>}
    {[-1, 1].map((side) => <group key={side}><Box at={[side * W / 2, .007, 0]} size={[.025, .014, D]} color="#789055" /><Box at={[0, .007, side * D / 2]} size={[W, .014, .025]} color="#789055" /></group>)}
    <Box at={[-W / 2 - .3, -.226, 0]} size={[.055, .018, D + .65]} color="#d1b562" />
    <Box at={[W / 2 + .3, -.226, 0]} size={[.055, .018, D + .65]} color="#d1b562" />
    {world?.destination && <group>
      <Label at={point([world.destination.center[0], world.destination.center[1], .13 / scale])} text={`OUTBOUND · ${world.destination.id}`} />
      <Box at={point([world.destination.center[0], world.destination.center[1], .008 / scale])} size={[world.destination.size[0] * scale, .016, world.destination.size[1] * scale]} color="#abc773" opacity={.65} />
      {[-1, 1].map((side) => <group key={side}><Box at={point([world.destination.center[0] + side * world.destination.size[0] / 2, world.destination.center[1], .014 / scale])} size={[.035, .028, world.destination.size[1] * scale]} color="#526c33" /><Box at={point([world.destination.center[0], world.destination.center[1] + side * world.destination.size[1] / 2, .014 / scale])} size={[world.destination.size[0] * scale, .028, .035]} color="#526c33" /></group>)}
    </group>}
    {world?.obstacles.map(obstacle)}
    {objects.map((object, index) => {
      const dimensions = size(object.dimensions); const at = point(object.position); const selected = object.id === targetId;
      const nativeQuaternion = (object as SimWorld["objects"][number]).orientation_quaternion;
      // For P(x,y,z)=(x,z,y), rotations become P R P^-1. Quaternion vector
      // components transform as axial vectors: det(P)*P*[qx,qy,qz].
      const orientation: [number, number, number, number] | undefined = nativeQuaternion ? [-nativeQuaternion[0], -nativeQuaternion[2], -nativeQuaternion[1], nativeQuaternion[3]] : undefined;
      return <group key={object.id} position={at} rotation={orientation ? undefined : [0, -object.yaw_rad, 0]} quaternion={orientation}>
        <Box at={[0, 0, 0]} size={dimensions} color={selected ? "#b2c87a" : COLORS[index % COLORS.length]!} opacity={object.visible ? 1 : .25} edges />
        <Box at={[0, dimensions[1] / 2 + .002, 0]} size={[dimensions[0] * .17, .004, dimensions[2] * .97]} color={selected ? "#e1edb8" : "#dfd1ae"} opacity={object.visible ? .95 : .2} />
        {selected && <Label at={[0, dimensions[1] / 2 + .22, 0]} text={`${object.id}${!object.visible ? " · UNCERTAIN" : " · TARGET"}`} />}
        {selected && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -dimensions[1] / 2 + .009, 0]}><ringGeometry args={[Math.max(dimensions[0], dimensions[2]) * .62, Math.max(dimensions[0], dimensions[2]) * .66, 48]} /><meshBasicMaterial color="#608038" transparent opacity={.8} side={THREE.DoubleSide} /></mesh>}
      </group>;
    })}
    {robot && nativeRobot && <group>
      {yamVisual ? <group matrix={nativeTransform} matrixAutoUpdate={false}><YamRobot meshPoses={robot.mesh_poses!} fallback={<>{robot.link_positions?.map((joint, index, chain) => index > 0 && <Link key={index} start={chain[index - 1]!} end={joint} radius={.012} color="#6d7b70" />)}</>} /></group>
        : articulated ? robot.link_positions!.map((joint, index, chain) => index > 0 && <Link key={index} start={point(chain[index - 1]!)} end={point(joint)} radius={.035} color="#6d7b70" />) : null}
    </group>}
    {robot && !nativeRobot && <group>
      {articulated ? <>
        <Box at={point([robot.link_positions![0]![0], robot.link_positions![0]![1], .035 / scale])} size={[.56, .07, .56]} color="#40544a" metalness={.65} edges />
        {[-1, 1].flatMap((x) => [-1, 1].map((z) => <mesh key={`${x}-${z}`} position={[point(robot.link_positions![0]!)[0] + x * .21, .046, point(robot.link_positions![0]!)[2] + z * .21]}><cylinderGeometry args={[.025, .025, .035, 8]} /><meshStandardMaterial color="#aeb9a6" metalness={.9} roughness={.3} /></mesh>))}
        {robot.link_positions!.map((joint, i, chain) => <group key={i}>{i > 0 && <Link start={point(chain[i - 1]!)} end={point(joint)} radius={i < 3 ? .13 : .08} color={i % 2 ? "#617754" : "#b7cd83"} industrial />}<mesh position={point(joint)} castShadow><sphereGeometry args={[i < 3 ? .16 : .105, 20, 16]} /><meshStandardMaterial color="#3f5549" metalness={.72} roughness={.28} /></mesh></group>)}
      </> : <>
        {[-1, 1].map((side) => <group key={side}><Box at={[side * (W / 2 + .11), gantryHeight / 2, -D / 2 - .1]} size={[post * 2, gantryHeight, post * 2]} color="#607360" metalness={.5} /><Box at={[side * (W / 2 + .11), gantryHeight / 2, D / 2 + .1]} size={[post * 2, gantryHeight, post * 2]} color="#607360" metalness={.5} /><Box at={[side * (W / 2 + .11), gantryHeight, 0]} size={[post * 2, post * 2, D + .25]} color="#6e8069" metalness={.65} /></group>)}
        <Box at={[0, gantryHeight + .05, point(robot.position)[2]]} size={[W + .32, .14, .16]} color="#455b4c" metalness={.65} edges />
        <Box at={[point(robot.position)[0], gantryHeight, point(robot.position)[2]]} size={[.26, .28, .3]} color="#b3c783" metalness={.35} edges />
        <Link start={[point(robot.position)[0], gantryHeight, point(robot.position)[2]]} end={point(robot.position)} radius={.055} color="#aeb8aa" />
      </>}
      <group position={point(robot.position)}>
        <Box at={[0, .06, 0]} size={[.22, .15, .22]} color="#45584b" metalness={.6} edges />
        {[-1, 1].map((side) => <Box key={side} at={[side * (robot.gripper_state === "closed" ? .065 : .14), -.065, 0]} size={[.045, .2, .1]} color="#ccd1c5" metalness={.8} />)}
      </group>
    </group>}
    <Controls handle={controls} extent={extent + Math.max(0, highest - 2) * .5} centerY={highest * .22} revision={`${width}:${depth}:${nativeRobot ? "native" : articulated ? "arm" : "cartesian"}`} robotFocus={robotFocus} targetFocus={objects.find((object) => object.id === targetId) ? point(objects.find((object) => object.id === targetId)!.position) : null} cinematic={cinematic} reducedMotion={reducedMotion} onManual={onManual} onShot={onShot} />
  </>;
}
export default function Warehouse3D(props: WorldProps & { onReady: (evidence: { frames: number; drawCalls: number }) => void; onUnavailable: (reason: string) => void }) {
  const controls = useRef<ControlsHandle | null>(null);
  const [focused, setFocused] = useState(false);
  const [cinematic, setCinematic] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [shot, setShot] = useState<CameraShot>("overview");
  const [showColliders, setShowColliders] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const reportReady = useCallback((evidence: { frames: number; drawCalls: number }) => { setRendererReady(true); props.onReady(evidence); }, [props.onReady]);
  const manual = useCallback(() => setCinematic(false), []);
  const shotChanged = useCallback((next: CameraShot) => setShot(next), []);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(preference.matches); setCinematic(!!props.cinematicDefault && !preference.matches);
    const change = () => { setReducedMotion(preference.matches); if (preference.matches) setCinematic(false); };
    preference.addEventListener("change", change); return () => preference.removeEventListener("change", change);
  }, [props.cinematicDefault]);
  return <div className="fl3-viewport" tabIndex={0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={(event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "r" || event.key === "Home") { controls.current?.reset(); event.preventDefault(); }
    if (event.key === "+" || event.key === "=") { controls.current?.zoom(.85); event.preventDefault(); }
    if (event.key === "-") { controls.current?.zoom(1.18); event.preventDefault(); }
  }} aria-label="Interactive 3D warehouse. Drag to orbit, right drag to pan, scroll to zoom. R resets the camera.">
    <Canvas shadows frameloop="demand" dpr={[1, 1.5]} camera={{ fov: 38, near: .03, far: 160 }} gl={{ antialias: true, alpha: false, powerPreference: "default", failIfMajorPerformanceCaveat: false }} fallback={<span>Interactive warehouse geometry. Choose Plan for the accessible scene view.</span>}>
      <RendererMonitor onReady={reportReady} onUnavailable={props.onUnavailable} />
      <Scene {...props} controls={controls} cinematic={cinematic} reducedMotion={reducedMotion} onManual={manual} onShot={shotChanged} showColliders={showColliders} />
    </Canvas>
    {!rendererReady && <div className="fl3-renderer-starting" role="status">Starting the 3D view…</div>}
    <div className="fl3-shot-controls" aria-label="Camera shot presets">{(["overview", "robot", "target", "top"] as CameraShot[]).map((name) => <button type="button" key={name} aria-pressed={shot === name} disabled={!rendererReady} onClick={() => controls.current?.preset(name)}>{name === "robot" ? "Robot" : name[0]!.toUpperCase() + name.slice(1)}</button>)}</div>
    <div className="fl3-presentation-controls"><button type="button" aria-pressed={cinematic} disabled={reducedMotion || !rendererReady} onClick={() => setCinematic(!cinematic)}>{cinematic ? "Cinematic on" : "Cinematic off"}</button><button type="button" aria-pressed={showColliders} disabled={!rendererReady} onClick={() => setShowColliders(!showColliders)}>Collider bounds {showColliders ? "on" : "off"}</button></div>
    <div className="fl3-camera-controls" aria-label="3D camera controls"><button type="button" title="Reset view (R)" disabled={!rendererReady} onClick={() => controls.current?.reset()}>Reset view</button><button type="button" aria-label="Zoom in" disabled={!rendererReady} onClick={() => controls.current?.zoom(.8)}>+</button><button type="button" aria-label="Zoom out" disabled={!rendererReady} onClick={() => controls.current?.zoom(1.25)}>−</button></div>
    <div className="fl3-interaction-note">{cinematic ? "Camera presentation only · drag to take control" : focused ? "R reset · + / − zoom" : "Drag orbit · right-drag pan · scroll zoom"}</div>
  </div>;
}
