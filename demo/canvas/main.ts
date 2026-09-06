/**
 * Canvas 2D reference renderer. RESEARCH.md option 1.
 * Software projection, painter's sort by bit depth, faces as quads, seams
 * as glowing strokes, corner beads as glowing discs. The model decides what
 * is drawn; this file only draws it.
 */
import {
  type BitHandle,
  EDGE_SLOTS,
  FACE_SLOTS,
  type Grid,
  localCenterOf,
  nodeVertices,
  type RenderItem,
  renderList,
  signsOf,
  VERTEX_SLOTS,
  type Vec3,
} from "../../src/index.ts";
import { COLORS, referenceScene, sceneCenter } from "../shared/scene.ts";
import {
  basisOf,
  type Mode,
  modelCamera,
  orbit,
  projector,
  type View,
  viewForMode,
} from "../shared/view.ts";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const hud = document.getElementById("hud")!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-mode]")];

const grid: Grid = referenceScene();
const target = sceneCenter();
let view: View = viewForMode("cube", target);
let lastPick: { bit: BitHandle; polys: { pts: { x: number; y: number }[] }[] }[] = [];

function hex(n: number, alpha = 1): string {
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function shade(color: number, k: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (c((color >> 16) & 255) << 16) | (c((color >> 8) & 255) << 8) | c(color & 255);
}

/** The four corners of a face in loop order. */
function faceCorners(bit: BitHandle, slot: number): Vec3[] {
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

function edgeEnds(bit: BitHandle, slot: number): Vec3[] {
  return nodeVertices(slot).map((v) => {
    const c = localCenterOf(v);
    return [bit.position[0] + c[0], bit.position[1] + c[1], bit.position[2] + c[2]];
  });
}

const LIGHT: Vec3 = (() => {
  const l = [0.35, 0.8, 0.5];
  const n = Math.hypot(l[0]!, l[1]!, l[2]!);
  return [l[0]! / n, l[1]! / n, l[2]! / n];
})();

function draw(): void {
  const basis = basisOf(view);
  grid.onCameraMoved();
  grid.evaluate(modelCamera(view, basis));
  const items = renderList(grid.bits());
  const project = projector(view, basis, canvas.width, canvas.height);

  // Group by bit, sort far to near.
  const byBit = new Map<BitHandle, RenderItem[]>();
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

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  lastPick = [];

  for (const { bit, its } of order) {
    const polys: { pts: { x: number; y: number }[] }[] = [];
    ctx.shadowBlur = 0;
    for (const it of its) {
      if (it.kind !== "face") continue;
      const pts = faceCorners(bit, it.slot).map(project);
      polys.push({ pts });
      const n = it.outward;
      const nl = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
      const k = 0.55 + 0.45 * Math.max(0, nl);
      ctx.fillStyle = hex(shade(it.emission.color ?? 0x888888, k));
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fill();
    }
    for (const it of its) {
      if (it.kind !== "edge") continue;
      const [a, b] = edgeEnds(bit, it.slot).map(project);
      const color = it.emission.color ?? 0xffffff;
      ctx.strokeStyle = hex(color, 0.95);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.shadowColor = hex(color, 0.9);
      ctx.shadowBlur = 6 * (it.emission.light ?? 1);
      ctx.beginPath();
      ctx.moveTo(a!.x, a!.y);
      ctx.lineTo(b!.x, b!.y);
      ctx.stroke();
    }
    for (const it of its) {
      if (it.kind !== "vertex") continue;
      const p = project(it.center);
      const color = it.emission.color ?? 0xffffff;
      ctx.fillStyle = hex(color);
      ctx.shadowColor = hex(color, 0.9);
      ctx.shadowBlur = 8 * (it.emission.light ?? 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    lastPick.push({ bit, polys });
  }
  ctx.shadowBlur = 0;

  const counts = countNodes(items);
  hud.textContent = [
    `mode     ${view.mode}`,
    `bits     ${grid.size} present`,
    `awake    ${[...grid.bits()].filter((b) => b.renderCycle).length}`,
    `faces    ${counts.face}`,
    `edges    ${counts.edge}`,
    `vertices ${counts.vertex}`,
    `nodes    ${items.length} of ${grid.size * 26}`,
  ].join("\n");
  for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.mode === view.mode));
  document.body.dataset.ready = "1";
  document.body.dataset.mode = view.mode;
}

function countNodes(items: RenderItem[]) {
  const c = { face: 0, edge: 0, vertex: 0 };
  for (const it of items) c[it.kind]++;
  return c;
}

function setMode(mode: Mode): void {
  view = viewForMode(mode, target, view);
  draw();
}

// --- interaction
for (const b of buttons) b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
window.addEventListener("keydown", (e) => {
  if (e.key === "1") setMode("pixel");
  if (e.key === "2") setMode("tile");
  if (e.key === "3") setMode("cube");
});

let drag: { x: number; y: number; moved: boolean } | null = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag || view.mode !== "cube") return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  if (!drag.moved) return;
  canvas.classList.add("dragging");
  view = orbit(view, dx, dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  draw();
});
canvas.addEventListener("pointerup", (e) => {
  canvas.classList.remove("dragging");
  const wasClick = drag && !drag.moved;
  drag = null;
  if (!wasClick) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) * canvas.width) / rect.width;
  const y = ((e.clientY - rect.top) * canvas.height) / rect.height;
  pick(x, y, e.shiftKey);
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

function pick(x: number, y: number, restore: boolean): void {
  // Nearest drawn last, so search from the end.
  for (let i = lastPick.length - 1; i >= 0; i--) {
    const { bit, polys } = lastPick[i]!;
    if (polys.some((p) => inside(p.pts, x, y))) {
      if (restore) {
        // Restore: put back any absent neighbor cell adjacent to this bit's face.
        for (const slot of FACE_SLOTS) {
          if (bit.linkCountOf(slot)) continue;
          const o = localCenterOf(slot);
          const cell: Vec3 = [
            bit.position[0] + o[0] * 2,
            bit.position[1] + o[1] * 2,
            bit.position[2] + o[2] * 2,
          ];
          if (!grid.has(cell) && cell.every((c) => c >= 0 && c < 8)) {
            const nb = grid.add(cell, { emission: { color: COLORS.face, light: 0.6 } });
            nb.emitAll(EDGE_SLOTS, { color: COLORS.edge, light: 1 });
            nb.emitAll(VERTEX_SLOTS, { color: COLORS.vertex, light: 1 });
            break;
          }
        }
      } else {
        grid.remove(bit);
      }
      draw();
      return;
    }
  }
}

// --- test hook
(window as unknown as { __vpb: unknown }).__vpb = {
  counts: () => {
    const items = renderList(grid.bits());
    return { ...countNodes(items), nodes: items.length, bits: grid.size };
  },
  setMode,
};

setMode("cube");
