/**
 * The reference scene every demo renders: an 8x8x8 with a 3x3x3 corner
 * carved out, faces blue, seams lighter blue, corner beads white.
 */
import { EDGE_SLOTS, Grid, VERTEX_SLOTS } from "../../src/index.ts";

export const COLORS = {
  face: 0x1f6feb,
  edge: 0x58a6ff,
  vertex: 0xffffff,
  background: "#0b0f19",
} as const;

export const SCENE_SIZE = 8;

export function referenceScene(size = SCENE_SIZE): Grid {
  const grid = Grid.fill(size, size, size, { emission: { color: COLORS.face, light: 0.6 } });
  for (const bit of grid.bits()) {
    bit.emitAll(EDGE_SLOTS, { color: COLORS.edge, light: 1 });
    bit.emitAll(VERTEX_SLOTS, { color: COLORS.vertex, light: 1 });
  }
  const from = size - 3;
  for (let z = from; z < size; z++)
    for (let y = from; y < size; y++) for (let x = from; x < size; x++) grid.remove([x, y, z]);
  return grid;
}

export function sceneCenter(size = SCENE_SIZE): readonly [number, number, number] {
  const c = (size - 1) / 2;
  return [c, c, c];
}
