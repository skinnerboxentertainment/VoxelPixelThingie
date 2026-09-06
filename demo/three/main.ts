/**
 * Three.js WebGPU renderer. RESEARCH.md option 3.
 * Three instanced draws (faces, edges, vertices) fed from the model's render
 * list. The model decides what is drawn; this file only draws it.
 */

import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { pass } from "three/tsl";
import * as THREE from "three/webgpu";
import {
  type Grid,
  type RenderItem,
  renderList,
  signsOf,
  type VoxelPixelBit,
} from "../../src/index.ts";
import { COLORS, referenceScene, sceneCenter } from "../shared/scene.ts";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const status = document.getElementById("status")!;
const sizeSelect = document.getElementById("size") as HTMLSelectElement;
const resetButton = document.getElementById("reset") as HTMLButtonElement;

// ---------------------------------------------------------------- model

let size = 8;
let grid: Grid = referenceScene(size);
let cameraDirty = true;

// ---------------------------------------------------------------- scene

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.background);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
const light = new THREE.DirectionalLight(0xffffff, 1.6);
light.position.set(0.35, 0.8, 0.5);
scene.add(light, new THREE.AmbientLight(0xffffff, 0.55));

const faceGeo = new THREE.PlaneGeometry(1, 1);
const edgeGeo = new THREE.BoxGeometry(1, 0.06, 0.06);
const vertexGeo = new THREE.SphereGeometry(0.075, 10, 8);
const faceMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
const glowMat = new THREE.MeshBasicMaterial();

class Layer {
  mesh: InstancedMeshT;
  bits: VoxelPixelBit[] = [];
  readonly geo: THREE.BufferGeometry;
  readonly mat: THREE.Material;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number) {
    this.geo = geo;
    this.mat = mat;
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    scene.add(this.mesh);
  }
  ensure(n: number): void {
    if (n <= this.mesh.instanceMatrix.count) return;
    scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, Math.ceil(n * 1.5));
    scene.add(this.mesh);
  }
}
type InstancedMeshT = THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>;

const faces = new Layer(faceGeo, faceMat, 4096);
const edges = new Layer(edgeGeo, glowMat, 1024);
const vertices = new Layer(vertexGeo, glowMat, 512);

const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);
const X = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);

function edgeDirection(slot: number): THREE.Vector3 {
  const s = signsOf(slot);
  const axis = s.findIndex((x) => x === null);
  return new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
}

let lastCounts = { face: 0, edge: 0, vertex: 0, nodes: 0 };

function fillLayer(layer: Layer, items: RenderItem[], orient: (it: RenderItem) => void): void {
  layer.ensure(items.length);
  layer.bits.length = items.length;
  const mesh = layer.mesh;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    orient(it);
    v.set(it.center[0], it.center[1], it.center[2]);
    m.compose(v, q, ONE);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setHex(it.emission.color ?? 0xffffff));
    layer.bits[i] = it.bit;
  }
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}

let modelMs = 0;

function syncInstances(): void {
  const items = renderList(grid.awake);
  const f: RenderItem[] = [];
  const e: RenderItem[] = [];
  const vx: RenderItem[] = [];
  for (const it of items) (it.kind === "face" ? f : it.kind === "edge" ? e : vx).push(it);
  fillLayer(faces, f, (it) =>
    q.setFromUnitVectors(Z, v.set(it.outward[0], it.outward[1], it.outward[2])),
  );
  fillLayer(edges, e, (it) => q.setFromUnitVectors(X, edgeDirection(it.slot)));
  fillLayer(vertices, vx, () => q.identity());
  lastCounts = { face: f.length, edge: e.length, vertex: vx.length, nodes: items.length };
}

// ---------------------------------------------------------------- camera & controls

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.addEventListener("change", () => {
  cameraDirty = true;
});

function frameScene(): void {
  const center = sceneCenter(size);
  controls.target.set(center[0], center[1], center[2]);
  camera.position.set(center[0] + size * 1.3, center[1] + size * 0.9, center[2] + size * 1.7);
  controls.update();
  cameraDirty = true;
}

// ---------------------------------------------------------------- frame stats

const frameTimes: number[] = [];
let lastFrame = performance.now();
/** Every animation frame, unfiltered. Tests use this to see that the loop runs. */
let frameCount = 0;
function frameStats() {
  const s = [...frameTimes].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), n: s.length };
}

// ---------------------------------------------------------------- renderer

let renderer: THREE.WebGPURenderer | null = null;
let postProcessing: THREE.PostProcessing | null = null;
let backend = "none";

async function initRenderer(): Promise<void> {
  try {
    const r = new THREE.WebGPURenderer({
      canvas,
      antialias: true,
      forceWebGL: !("gpu" in navigator),
    });
    await r.init();
    renderer = r;
    backend = (r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl2";
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode("output");
    const bloomPass = bloom(color, 0.9, 0.35, 0.5);
    postProcessing = new THREE.PostProcessing(r);
    postProcessing.outputNode = color.add(bloomPass);
    try {
      r.xr.enabled = true;
      document.body.appendChild(VRButton.createButton(r));
    } catch {
      // No XR on this platform; the demo does not need it.
    }
    resize();
    window.addEventListener("resize", resize);
    r.setAnimationLoop(tick);
  } catch (err) {
    backend = "none";
    status.textContent = `renderer unavailable: ${(err as Error).message}`;
  }
  document.body.dataset.renderer = backend;
}

function resize(): void {
  if (!renderer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  cameraDirty = true;
}

function updateModel(): void {
  if (cameraDirty) {
    const t0 = performance.now();
    const cam = { position: [camera.position.x, camera.position.y, camera.position.z] as const };
    grid.cameraMoved(cam);
    syncInstances();
    modelMs = performance.now() - t0;
    cameraDirty = false;
    updateHud();
  }
}

function tick(): void {
  const now = performance.now();
  const dt = now - lastFrame;
  lastFrame = now;
  frameCount++;
  // Drop stalls (tab hidden, scene load) so the stats describe steady frames.
  if (dt < 250) {
    frameTimes.push(dt);
    if (frameTimes.length > 240) frameTimes.shift();
  }
  controls.update();
  updateModel();
  if (postProcessing) postProcessing.render();
  else renderer?.render(scene, camera);
  if (frameTimes.length % 30 === 0) updateHud();
  document.body.dataset.ready = "1";
}

function updateHud(): void {
  const fs = frameStats();
  hud.textContent = [
    `renderer ${backend}`,
    `size     ${size}³`,
    `bits     ${grid.size} present`,
    `awake    ${grid.awake.length}`,
    `faces    ${lastCounts.face}`,
    `edges    ${lastCounts.edge}`,
    `vertices ${lastCounts.vertex}`,
    `nodes    ${lastCounts.nodes} of ${grid.size * 26}`,
    `frame    p50 ${fs.p50.toFixed(1)} ms  p95 ${fs.p95.toFixed(1)} ms  n=${fs.n}`,
    `model    ${modelMs.toFixed(1)} ms last camera pass`,
  ].join("\n");
}

// ---------------------------------------------------------------- interaction

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let down: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (e) => {
  down = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointerup", (e) => {
  if (!down) return;
  const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 3;
  down = null;
  if (moved) return;
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(faces.mesh, false)[0];
  if (!hit || hit.instanceId === undefined) return;
  const bit = faces.bits[hit.instanceId];
  if (bit) removeBit(bit);
});

function removeBit(bit: VoxelPixelBit): void {
  grid.remove(bit);
  cameraDirty = true;
  if (!renderer) {
    updateModel();
  }
}

function loadSize(n: number): void {
  size = n;
  grid = referenceScene(size);
  cameraDirty = true;
  frameScene();
  frameTimes.length = 0;
  lastFrame = performance.now();
  if (!renderer) updateModel();
}

sizeSelect.addEventListener("change", () => loadSize(Number(sizeSelect.value)));
resetButton.addEventListener("click", () => loadSize(size));

// ---------------------------------------------------------------- test hook

(window as unknown as { __vpb: unknown }).__vpb = {
  counts: () => {
    const items = renderList(grid.bits());
    const cnt = { face: 0, edge: 0, vertex: 0 };
    for (const it of items) cnt[it.kind]++;
    return { ...cnt, nodes: items.length, bits: grid.size, awake: grid.awake.length };
  },
  frameStats,
  frameCount: () => frameCount,
  removeCenterFacingBit: () => {
    // Deterministic removal: a visible bit in the interior of a face, so the
    // pit it leaves exposes the enclosed bit beneath it and its four sides.
    const interior = (c: number) => c > 0 && c < size - 1;
    let best: VoxelPixelBit | undefined;
    let bestScore = -1;
    for (const b of faces.bits) {
      const score = b.position.filter(interior).length;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best) removeBit(best);
    return best ? { id: best.id, position: [...best.position] } : undefined;
  },
  debug: () => ({
    awake: grid.awake.length,
    frames: frameCount,
    cameraDirty,
    renderCycleBits: [...grid.bits()].filter((b) => b.renderCycle).length,
  }),
  loadSize,
  backend: () => backend,
};

// ---------------------------------------------------------------- go

frameScene();
updateModel();
updateHud();
await initRenderer();
if (!renderer) document.body.dataset.ready = "1";
