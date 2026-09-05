/**
 * PixiJS v8 pixel-mode renderer. RESEARCH.md option 2.
 * Pure 2D: the camera looks straight down Z, so at most nine nodes per bit
 * can ever render (the +Z face, its four edges, its four vertices). A
 * second layer of bits sits behind the first and shows through where the
 * front is carved. The model decides what is drawn; this file only draws.
 */
import { Application, BlurFilter, Graphics } from "pixi.js";
import {
  EDGE_SLOTS,
  Grid,
  localCenterOf,
  nodeVertices,
  type RenderItem,
  renderList,
  signsOf,
  VERTEX_SLOTS,
  type Vec3,
  type VoxelPixelBit,
} from "../../src/index.ts";
import { COLORS } from "../shared/scene.ts";
import {
  basisOf,
  type Mode,
  modelCamera,
  projector,
  type View,
  viewForMode,
} from "../shared/view.ts";

const W = 16;
const H = 16;
const BACK_FACE = 0x0f3a7a;

/** Front layer at z = 0 with a carved pattern; back layer at z = -1, darker. */
function layerScene(): Grid {
  const grid = new Grid();
  const carved = new Set<string>();
  // A 4x4 window and a diagonal stroke, so depth shows through in two shapes.
  for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) carved.add(`${x},${y}`);
  for (let i = 1; i < 6; i++) carved.add(`${i},${i}`);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const back = grid.add([x, y, -1], { emission: { color: BACK_FACE, light: 0.3 } });
      back.emitAll(EDGE_SLOTS, { color: 0x2a5fa8, light: 0.6 });
      back.emitAll(VERTEX_SLOTS, { color: 0x9fbce6, light: 0.6 });
      if (carved.has(`${x},${y}`)) continue;
      const front = grid.add([x, y, 0], { emission: { color: COLORS.face, light: 0.6 } });
      front.emitAll(EDGE_SLOTS, { color: COLORS.edge, light: 1 });
      front.emitAll(VERTEX_SLOTS, { color: COLORS.vertex, light: 1 });
    }
  }
  return grid;
}

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-mode]")];

const grid = layerScene();
const target: Vec3 = [(W - 1) / 2, (H - 1) / 2, -0.5];
let view: View = viewForMode("pixel", target);
view = { ...view, zoom: 30 };

const app = new Application();
await app.init({
  canvas,
  width: canvas.width,
  height: canvas.height,
  background: COLORS.background,
  antialias: true,
  resolution: 1,
  autoDensity: false,
});

const faces = new Graphics();
const glow = new Graphics();
const lines = new Graphics();
glow.filters = [new BlurFilter({ strength: 7, quality: 4 })];
glow.blendMode = "add";
app.stage.addChild(faces, glow, lines);

function faceCorners(bit: VoxelPixelBit, slot: number): Vec3[] {
  const signs = signsOf(slot);
  const axis = signs.findIndex((s) => s !== null);
  const others = [0, 1, 2].filter((a) => a !== axis);
  const loop: [number, number][] = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  return loop.map(([b, c]) => {
    const p: [number, number, number] = [0, 0, 0];
    p[axis] = signs[axis] === 1 ? 0.5 : -0.5;
    p[others[0]!] = b;
    p[others[1]!] = c;
    return [bit.position[0] + p[0], bit.position[1] + p[1], bit.position[2] + p[2]];
  });
}

function edgeEnds(bit: VoxelPixelBit, slot: number): Vec3[] {
  return nodeVertices(slot).map((v) => {
    const c = localCenterOf(v);
    return [bit.position[0] + c[0], bit.position[1] + c[1], bit.position[2] + c[2]];
  });
}

let picks: { bit: VoxelPixelBit; pts: { x: number; y: number }[] }[] = [];
let lastCounts = { face: 0, edge: 0, vertex: 0, nodes: 0 };

function draw(): void {
  const basis = basisOf(view);
  grid.onCameraMoved();
  grid.evaluate(modelCamera(view, basis));
  const items = renderList(grid.awake);
  const project = projector(view, basis, canvas.width, canvas.height);
  // Pixel mode has no perspective, so depth is shown as a small screen shift per layer.
  const parallax = view.mode === "pixel" ? 5 : 0;
  const proj = (p: Vec3, bit: VoxelPixelBit) => {
    const s = project(p);
    return {
      x: s.x - bit.position[2] * parallax,
      y: s.y + bit.position[2] * parallax,
      depth: s.depth,
    };
  };

  const byBit = new Map<VoxelPixelBit, RenderItem[]>();
  for (const it of items) {
    let arr = byBit.get(it.bit);
    if (!arr) {
      arr = [];
      byBit.set(it.bit, arr);
    }
    arr.push(it);
  }
  const order = [...byBit.entries()]
    .map(([bit, its]) => ({ bit, its, depth: project(bit.position).depth }))
    .sort((a, b) => b.depth - a.depth);

  faces.clear();
  glow.clear();
  lines.clear();
  picks = [];
  const counts = { face: 0, edge: 0, vertex: 0 };

  for (const { bit, its } of order) {
    let facePts: { x: number; y: number }[] | null = null;
    for (const it of its) {
      if (it.kind !== "face") continue;
      counts.face++;
      const pts = faceCorners(bit, it.slot).map((p) => proj(p, bit));
      if (it.slot === 5) facePts = pts;
      const k = it.slot === 5 ? 1 : it.slot === 3 || it.slot === 1 ? 0.8 : 0.65;
      faces
        .poly(pts.flatMap((p) => [p.x, p.y]))
        .fill({ color: it.emission.color ?? 0x888888, alpha: k });
    }
    for (const it of its) {
      if (it.kind !== "edge") continue;
      counts.edge++;
      const [a, b] = edgeEnds(bit, it.slot).map((p) => proj(p, bit));
      const color = it.emission.color ?? 0xffffff;
      const light = it.emission.light ?? 1;
      glow
        .moveTo(a!.x, a!.y)
        .lineTo(b!.x, b!.y)
        .stroke({ width: 5, color, alpha: 0.6 * light });
      lines.moveTo(a!.x, a!.y).lineTo(b!.x, b!.y).stroke({ width: 1.5, color, alpha: 0.95 });
    }
    for (const it of its) {
      if (it.kind !== "vertex") continue;
      counts.vertex++;
      const p = proj(it.center, bit);
      const color = it.emission.color ?? 0xffffff;
      const light = it.emission.light ?? 1;
      glow.circle(p.x, p.y, 4).fill({ color, alpha: 0.7 * light });
      lines.circle(p.x, p.y, 2).fill({ color, alpha: 1 });
    }
    if (facePts) picks.push({ bit, pts: facePts });
  }
  lastCounts = { ...counts, nodes: items.length };

  hud.textContent = [
    `mode     ${view.mode}`,
    `bits     ${grid.size} present`,
    `awake    ${grid.awake.length}`,
    `faces    ${counts.face}`,
    `edges    ${counts.edge}`,
    `vertices ${counts.vertex}`,
    `nodes    ${items.length} of ${grid.size * 26}`,
  ].join("\n");
  for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.mode === view.mode));
  document.body.dataset.mode = view.mode;
  app.render();
  document.body.dataset.ready = "1";
}

function setMode(mode: Mode): void {
  if (mode === "cube") return;
  view = viewForMode(mode, target, view);
  view = { ...view, zoom: mode === "pixel" ? 30 : 22 };
  draw();
}

for (const b of buttons) b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
window.addEventListener("keydown", (e) => {
  if (e.key === "1") setMode("pixel");
  if (e.key === "2") setMode("tile");
});

function inside(pts: { x: number; y: number }[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) * canvas.width) / rect.width;
  const y = ((e.clientY - rect.top) * canvas.height) / rect.height;
  for (let i = picks.length - 1; i >= 0; i--) {
    const p = picks[i]!;
    if (inside(p.pts, x, y)) {
      grid.remove(p.bit);
      draw();
      return;
    }
  }
});

(window as unknown as { __vpb: unknown }).__vpb = {
  counts: () => ({ ...lastCounts, bits: grid.size, awake: grid.awake.length }),
  setMode,
  removeAt: (x: number, y: number, z: number) => {
    const bit = grid.at(x, y, z);
    if (bit) grid.remove(bit);
    draw();
    return Boolean(bit);
  },
};

app.ticker.stop();
setMode("pixel");
