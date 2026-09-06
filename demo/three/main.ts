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
  type BitEvent,
  type BitHandle,
  type Container,
  type JsonObject,
  MemoryStore,
  OpfsStore,
  OpfsWorkerStore,
  OverlayStore,
  openScene,
  PackedStore,
  packScene,
  packToText,
  RecordingSink,
  type RenderItem,
  renderList,
  SceneSink,
  signsOf,
  TeeSink,
} from "../../src/index.ts";
import { COLORS, referenceScene, sceneCenter } from "../shared/scene.ts";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const status = document.getElementById("status")!;
const sizeSelect = document.getElementById("size") as HTMLSelectElement;
const resetButton = document.getElementById("reset") as HTMLButtonElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const loadButton = document.getElementById("load") as HTMLButtonElement;
const panel = document.getElementById("panel") as HTMLDivElement;
const panelTitle = document.getElementById("panel-title")!;
const passportBox = document.getElementById("passport") as HTMLTextAreaElement;
const panelError = document.getElementById("panel-error")!;
const SCENE_DIR = "vpb/scenes";
const SCENE_FILE = "three.pack.json";
const AUTOSAVE_ROOT = "vpb/scenes/three-autosave";
const autosaveBox = document.getElementById("autosave") as HTMLInputElement;
const loadAutosaveButton = document.getElementById("load-autosave") as HTMLButtonElement;

// ---------------------------------------------------------------- model

let size = 8;
/** Sizes that record a full ledger and can be saved; larger scenes render only. */
const SAVE_MAX = 16;
let recorder: RecordingSink | null = null;
let grid: Container = makeScene(size);
let cameraDirty = true;
let selected: BitHandle | null = null;

function makeScene(n: number): Container {
  recorder = n <= SAVE_MAX ? new RecordingSink() : null;
  return referenceScene(n, recorder ?? undefined);
}

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
  bits: BitHandle[] = [];
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
  if (bit) select(bit);
});

// ---------------------------------------------------------------- passport panel

function select(bit: BitHandle | null): void {
  selected = bit;
  panel.hidden = !bit;
  panelError.textContent = "";
  if (!bit) return;
  panelTitle.textContent = `bit ${bit.id}\nat ${bit.key}`;
  passportBox.value = JSON.stringify(bit.passport, null, 2);
}

function applyPassport(): boolean {
  if (!selected) return false;
  try {
    const obj = JSON.parse(passportBox.value) as JsonObject;
    selected.setPassport(obj);
    panelError.textContent = "";
    return true;
  } catch (err) {
    panelError.textContent = (err as Error).message;
    return false;
  }
}

document.getElementById("apply")!.addEventListener("click", applyPassport);
document.getElementById("close")!.addEventListener("click", () => select(null));
document.getElementById("remove")!.addEventListener("click", () => {
  if (selected) removeBit(selected);
  select(null);
});

// ---------------------------------------------------------------- save and load (SPEC.md §10, OpfsStore)

/**
 * Save writes one packed file (SPEC.md §10.8): the scene is laid out in
 * memory through a SceneSink, packed, and written with a single OPFS
 * operation instead of one per bit file (PLAN-2.md Phase 8).
 */
async function save(): Promise<{ ok: boolean; reason?: string; events?: number; ms?: number }> {
  if (!recorder) return { ok: false, reason: `scenes above ${SAVE_MAX}³ are not recorded` };
  if (!OpfsStore.available()) return { ok: false, reason: "no origin private file system" };
  const t0 = performance.now();
  status.textContent = "saving…";
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  for (const e of recorder.events) sink.record(e);
  await sink.flush();
  const text = packToText(await packScene(mem));
  const store = await OpfsStore.open(SCENE_DIR);
  await store.write(SCENE_FILE, text);
  const ms = performance.now() - t0;
  status.textContent = `saved ${recorder.events.length} events, ${(text.length / 1048576).toFixed(1)} MB, ${ms.toFixed(0)} ms`;
  return { ok: true, events: recorder.events.length, ms };
}

async function load(): Promise<{ ok: boolean; reason?: string; bits?: number; ms?: number }> {
  if (!OpfsStore.available()) return { ok: false, reason: "no origin private file system" };
  const t0 = performance.now();
  let text: string | undefined;
  try {
    const store = await OpfsStore.open(SCENE_DIR, { create: false });
    text = await store.read(SCENE_FILE);
  } catch {
    text = undefined;
  }
  if (!text) {
    status.textContent = "nothing saved yet";
    return { ok: false, reason: "no saved scene" };
  }
  status.textContent = "loading…";
  try {
    recorder = new RecordingSink();
    const loaded = await openScene(PackedStore.fromText(text), { sink: recorder });
    grid = loaded;
    size = Math.max(8, Math.ceil(Math.cbrt(loaded.size)));
    select(null);
    cameraDirty = true;
    frameScene();
    const ms = performance.now() - t0;
    status.textContent = `loaded ${loaded.size} bits, ${ms.toFixed(0)} ms`;
    if (!renderer) updateModel();
    return { ok: true, bits: loaded.size, ms };
  } catch (err) {
    status.textContent = `load failed: ${(err as Error).message}`;
    return { ok: false, reason: (err as Error).message };
  }
}

saveButton.addEventListener("click", () => void save());
loadButton.addEventListener("click", () => void load());

// ---------------------------------------------------------------- autosave (PLAN-2.md Phase 8, OpfsWorkerStore)

let autosaveStore: OpfsWorkerStore | null = null;
let autosaveSink: SceneSink | null = null;
const AUTOSAVE_BASE = "base.pack.json";

function workerStore(): OpfsWorkerStore {
  if (!autosaveStore) {
    const worker = new Worker(new URL("../../src/opfs-worker.ts", import.meta.url), {
      type: "module",
    });
    autosaveStore = new OpfsWorkerStore(worker, AUTOSAVE_ROOT);
  }
  return autosaveStore;
}

/**
 * Turn autosave on: start a fresh autosaved scene from the recorder's
 * events, then tee every new event to a scene sink over the worker store.
 * Off: the recorder alone.
 */
async function setAutosave(on: boolean): Promise<{ ok: boolean; reason?: string; ms?: number }> {
  autosaveBox.checked = on;
  if (!on) {
    autosaveSink = null;
    if (recorder) grid.attachSink(recorder);
    status.textContent = "autosave off";
    return { ok: true };
  }
  if (!recorder) return { ok: false, reason: `scenes above ${SAVE_MAX}³ are not recorded` };
  if (!OpfsStore.available()) return { ok: false, reason: "no origin private file system" };
  const t0 = performance.now();
  status.textContent = "autosave: writing the scene…";
  // Seed: the whole scene as one packed base file, one file operation.
  // Then every edit goes to a delta folder through the overlay.
  const mem = new MemoryStore();
  const seedSink = new SceneSink(mem);
  for (const e of recorder.events) seedSink.record(e);
  await seedSink.flush();
  const text = packToText(await packScene(mem));
  const ws = workerStore();
  await ws.remove();
  await ws.write(AUTOSAVE_BASE, text);
  const overlay = OverlayStore.fresh(PackedStore.fromText(text), ws);
  const sink = await SceneSink.resume(overlay);
  autosaveSink = sink;
  grid.attachSink(new TeeSink([recorder, sink]));
  const ms = performance.now() - t0;
  status.textContent = `autosave on, ${ms.toFixed(0)} ms to seed`;
  return { ok: true, ms };
}

async function autosaveFlush(): Promise<{ ok: boolean; events: number }> {
  if (autosaveSink) await autosaveSink.flush();
  return { ok: Boolean(autosaveSink), events: recorder?.events.length ?? -1 };
}

async function loadAutosave(): Promise<{
  ok: boolean;
  reason?: string;
  bits?: number;
  ms?: number;
}> {
  if (!OpfsStore.available()) return { ok: false, reason: "no origin private file system" };
  const t0 = performance.now();
  const ws = workerStore();
  const baseText = await ws.read(AUTOSAVE_BASE);
  if (!baseText) {
    status.textContent = "no autosaved scene";
    return { ok: false, reason: "no autosaved scene" };
  }
  status.textContent = "loading autosave…";
  try {
    const store = await OverlayStore.open(PackedStore.fromText(baseText), ws);
    recorder = new RecordingSink();
    const loaded = await openScene(store, { sink: recorder });
    grid = loaded;
    size = Math.max(8, Math.ceil(Math.cbrt(loaded.size)));
    select(null);
    cameraDirty = true;
    frameScene();
    if (autosaveBox.checked) {
      // Continue the same scene rather than seeding a new one.
      autosaveSink = await SceneSink.resume(store);
      grid.attachSink(new TeeSink([recorder, autosaveSink]));
    }
    const ms = performance.now() - t0;
    status.textContent = `loaded autosave, ${loaded.size} bits, ${ms.toFixed(0)} ms`;
    if (!renderer) updateModel();
    return { ok: true, bits: loaded.size, ms };
  } catch (err) {
    status.textContent = `load failed: ${(err as Error).message}`;
    return { ok: false, reason: (err as Error).message };
  }
}

autosaveBox.addEventListener("change", () => void setAutosave(autosaveBox.checked));
loadAutosaveButton.addEventListener("click", () => void loadAutosave());

function removeBit(bit: BitHandle): void {
  grid.remove(bit);
  cameraDirty = true;
  if (!renderer) {
    updateModel();
  }
}

function loadSize(n: number): void {
  size = n;
  grid = makeScene(size);
  select(null);
  cameraDirty = true;
  if (autosaveBox.checked) void setAutosave(true);
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
    let best: BitHandle | undefined;
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
  save,
  load,
  autosave: setAutosave,
  autosaveFlush,
  loadAutosave,
  selectFirstFaceBit: () => {
    const bit = faces.bits[0];
    if (bit) select(bit);
    return bit?.id;
  },
  setPassportOnSelected: (obj: JsonObject) => {
    passportBox.value = JSON.stringify(obj);
    return applyPassport();
  },
  passportOf: (id: string) => grid.get(id)?.passport,
  eventCount: () => recorder?.events.length ?? -1,
  lastEvent: (): BitEvent | undefined => recorder?.events[recorder.events.length - 1],
};

// ---------------------------------------------------------------- go

frameScene();
updateModel();
updateHud();
await initRenderer();
if (new URLSearchParams(location.search).get("autosave") === "1") await setAutosave(true);
if (!renderer) document.body.dataset.ready = "1";
