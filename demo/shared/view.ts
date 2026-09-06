/**
 * Camera math shared by the 2D demos. A view is a target, a yaw, a pitch,
 * a distance, and whether it is orthographic. Projection is CPU-side.
 */
import type { Camera, Vec3 } from "../../src/index.ts";

export type Mode = "pixel" | "tile" | "cube";

export interface View {
  mode: Mode;
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
  ortho: boolean;
  /** Screen pixels per world unit at the target depth. */
  zoom: number;
}

const DEG = Math.PI / 180;

export function viewForMode(mode: Mode, target: Vec3, prev?: View): View {
  const base = { mode, target, distance: 24, zoom: 48 };
  switch (mode) {
    case "pixel":
      return { ...base, yaw: 0, pitch: 0, ortho: true, zoom: 56 };
    case "tile":
      return { ...base, yaw: 45 * DEG, pitch: Math.atan(Math.SQRT1_2), ortho: true, zoom: 40 };
    case "cube":
      return {
        ...base,
        yaw: prev?.mode === "cube" ? prev.yaw : 32 * DEG,
        pitch: prev?.mode === "cube" ? prev.pitch : 24 * DEG,
        ortho: false,
        zoom: 44,
      };
  }
}

export interface Basis {
  cam: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function basisOf(v: View): Basis {
  const cp = Math.cos(v.pitch);
  const dir: Vec3 = [cp * Math.sin(v.yaw), Math.sin(v.pitch), cp * Math.cos(v.yaw)];
  const cam: Vec3 = [
    v.target[0] + dir[0] * v.distance,
    v.target[1] + dir[1] * v.distance,
    v.target[2] + dir[2] * v.distance,
  ];
  const forward = norm([v.target[0] - cam[0], v.target[1] - cam[1], v.target[2] - cam[2]]);
  const worldUp: Vec3 = Math.abs(forward[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
  const right = norm(cross(forward, worldUp));
  const up = cross(right, forward);
  return { cam, right, up, forward };
}

/** The model's camera: for orthographic views, a point far along the view axis. */
export function modelCamera(v: View, b: Basis): Camera {
  if (!v.ortho) return { position: b.cam };
  const far = 1e4;
  return {
    position: [
      v.target[0] - b.forward[0] * far,
      v.target[1] - b.forward[1] * far,
      v.target[2] - b.forward[2] * far,
    ],
    towardCamera: [-b.forward[0], -b.forward[1], -b.forward[2]],
  };
}

export interface Projected {
  x: number;
  y: number;
  /** Depth along the view direction; larger is farther. */
  depth: number;
}

export function projector(v: View, b: Basis, width: number, height: number) {
  const cx = width / 2;
  const cy = height / 2;
  const focal = v.zoom * v.distance;
  return (p: Vec3): Projected => {
    const rel: Vec3 = [p[0] - b.cam[0], p[1] - b.cam[1], p[2] - b.cam[2]];
    const x = dot(rel, b.right);
    const y = dot(rel, b.up);
    const depth = dot(rel, b.forward);
    const s = v.ortho ? v.zoom : focal / Math.max(depth, 1e-3);
    return { x: cx + x * s, y: cy - y * s, depth };
  };
}

export function orbit(v: View, dYawPx: number, dPitchPx: number): View {
  const yaw = v.yaw - dYawPx * 0.01;
  const pitch = Math.max(-1.5, Math.min(1.5, v.pitch + dPitchPx * 0.01));
  return { ...v, yaw, pitch };
}

/**
 * A keyboard cursor over the grid (PLAN-4.md Phase 24): arrows move it in
 * x and y, PageUp and PageDown (or shift with an arrow) in z, wrapping
 * inside the scene's bounds. Shared by the demos so mouse and keyboard
 * end in one selection path.
 */
export function stepCursor(
  cursor: Vec3,
  key: string,
  shift: boolean,
  size: number,
): Vec3 | undefined {
  const wrap = (v: number) => ((v % size) + size) % size;
  let [x, y, z] = cursor;
  switch (key) {
    case "ArrowLeft":
      if (shift) z -= 1;
      else x -= 1;
      break;
    case "ArrowRight":
      if (shift) z += 1;
      else x += 1;
      break;
    case "ArrowUp":
      if (shift) z += 1;
      else y += 1;
      break;
    case "ArrowDown":
      if (shift) z -= 1;
      else y -= 1;
      break;
    case "PageUp":
      z += 1;
      break;
    case "PageDown":
      z -= 1;
      break;
    default:
      return undefined;
  }
  return [wrap(x), wrap(y), wrap(z)];
}

export const CURSOR_HELP =
  "Scene. Arrow keys move the cursor, Page Up and Page Down move it in depth, Enter opens the bit under it, Delete removes it, Escape closes the panel.";
