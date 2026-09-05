/**
 * Slot math for a VoxelPixelBit's 26 nodes. Implements SPEC.md §5.3–5.7 and
 * the partner rule of §7. Everything here is pure and derived from one sign
 * convention: negative = 0, positive = 1, axes ordered X, Y, Z with X as the
 * low bit.
 */

export const X = 0;
export const Y = 1;
export const Z = 2;
export type Axis = 0 | 1 | 2;
export type Sign = 0 | 1;

/** A node's local index in 0..25. */
export type Slot = number;

/** Integer neighbor offset, each component in {-1, 0, +1}. */
export type Offset = readonly [number, number, number];

export const FACE_BASE = 0;
export const EDGE_BASE = 6;
export const VERTEX_BASE = 18;
export const NODE_COUNT = 26;

export type NodeKind = "face" | "edge" | "vertex";

/**
 * Signs of a node on each axis. `null` on an axis the node spans: an edge
 * on the axis it runs along, a face on its two in-plane axes.
 */
export type NodeSigns = readonly [Sign | null, Sign | null, Sign | null];

const AXES: readonly Axis[] = [X, Y, Z];

// ---------------------------------------------------------------- slot formulas (§5.4–5.6)

export function faceSlot(axis: Axis, sign: Sign): Slot {
  return FACE_BASE + 2 * axis + sign;
}

/** `axis` is the axis the edge runs along; A and B are the other two in X,Y,Z order. */
export function edgeSlot(axis: Axis, signA: Sign, signB: Sign): Slot {
  return EDGE_BASE + 4 * axis + signA + 2 * signB;
}

export function vertexSlot(sx: Sign, sy: Sign, sz: Sign): Slot {
  return VERTEX_BASE + sx + 2 * sy + 4 * sz;
}

export function kindOf(slot: Slot): NodeKind {
  if (slot < FACE_BASE || slot >= NODE_COUNT || !Number.isInteger(slot)) {
    throw new RangeError(`slot out of range: ${slot}`);
  }
  if (slot < EDGE_BASE) return "face";
  if (slot < VERTEX_BASE) return "edge";
  return "vertex";
}

export function isFace(slot: Slot): boolean {
  return kindOf(slot) === "face";
}
export function isEdge(slot: Slot): boolean {
  return kindOf(slot) === "edge";
}
export function isVertex(slot: Slot): boolean {
  return kindOf(slot) === "vertex";
}

export const ALL_SLOTS: readonly Slot[] = Array.from({ length: NODE_COUNT }, (_, i) => i);
export const FACE_SLOTS: readonly Slot[] = ALL_SLOTS.slice(FACE_BASE, EDGE_BASE);
export const EDGE_SLOTS: readonly Slot[] = ALL_SLOTS.slice(EDGE_BASE, VERTEX_BASE);
export const VERTEX_SLOTS: readonly Slot[] = ALL_SLOTS.slice(VERTEX_BASE, NODE_COUNT);

// ---------------------------------------------------------------- signs <-> slot

export function signsOf(slot: Slot): NodeSigns {
  const out: [Sign | null, Sign | null, Sign | null] = [null, null, null];
  switch (kindOf(slot)) {
    case "face": {
      const r = slot - FACE_BASE;
      out[(r >> 1) as Axis] = (r & 1) as Sign;
      return out;
    }
    case "edge": {
      const r = slot - EDGE_BASE;
      const along = (r >> 2) as Axis;
      const [a, b] = AXES.filter((ax) => ax !== along) as [Axis, Axis];
      out[a] = (r & 1) as Sign;
      out[b] = ((r >> 1) & 1) as Sign;
      return out;
    }
    case "vertex": {
      const r = slot - VERTEX_BASE;
      return [(r & 1) as Sign, ((r >> 1) & 1) as Sign, ((r >> 2) & 1) as Sign];
    }
  }
}

/** Inverse of signsOf. */
export function slotOf(signs: NodeSigns): Slot {
  const nulls = AXES.filter((ax) => signs[ax] === null);
  switch (nulls.length) {
    case 0:
      return vertexSlot(signs[X] as Sign, signs[Y] as Sign, signs[Z] as Sign);
    case 1: {
      const along = nulls[0] as Axis;
      const [a, b] = AXES.filter((ax) => ax !== along) as [Axis, Axis];
      return edgeSlot(along, signs[a] as Sign, signs[b] as Sign);
    }
    case 2: {
      const axis = AXES.find((ax) => signs[ax] !== null) as Axis;
      return faceSlot(axis, signs[axis] as Sign);
    }
    default:
      throw new RangeError("a node must have a sign on at least one axis");
  }
}

// ---------------------------------------------------------------- incidence (§5.7)

/** True when `inner` lies on `outer`: every axis where outer has a sign, inner has the same sign. */
export function lies(inner: Slot, outer: Slot): boolean {
  const a = signsOf(inner);
  const b = signsOf(outer);
  return AXES.every((ax) => b[ax] === null || a[ax] === b[ax]);
}

/** Vertices bounding a node. 2 for an edge, 4 for a face, itself for a vertex. */
export function nodeVertices(slot: Slot): Slot[] {
  return VERTEX_SLOTS.filter((v) => lies(v, slot));
}

/** The 4 edges bounding a face. */
export function faceEdges(face: Slot): Slot[] {
  if (!isFace(face)) throw new RangeError(`not a face slot: ${face}`);
  return EDGE_SLOTS.filter((e) => lies(e, face));
}

/** The 2 vertices at the ends of an edge. */
export function edgeVertices(edge: Slot): Slot[] {
  if (!isEdge(edge)) throw new RangeError(`not an edge slot: ${edge}`);
  return nodeVertices(edge);
}

// ---------------------------------------------------------------- geometry helpers

/**
 * Outward direction of a node relative to the bit center, in bit units.
 * A face gives its unit normal; an edge the sum of its two face normals; a
 * vertex the sum of its three. Used for the back-facing test (§8.2).
 */
export function outwardOf(slot: Slot): [number, number, number] {
  const s = signsOf(slot);
  return [
    s[X] === null ? 0 : s[X] === 1 ? 1 : -1,
    s[Y] === null ? 0 : s[Y] === 1 ? 1 : -1,
    s[Z] === null ? 0 : s[Z] === 1 ? 1 : -1,
  ];
}

/** Center of a node relative to the bit center, where the bit spans -0.5..+0.5 on each axis. */
export function localCenterOf(slot: Slot): [number, number, number] {
  const o = outwardOf(slot);
  return [o[0] * 0.5, o[1] * 0.5, o[2] * 0.5];
}

// ---------------------------------------------------------------- partner rule (§7)

/**
 * The slot on a neighbor at `offset` that touches `slot`, or null when no
 * link exists. Sign flips on every axis where the offset is nonzero; the
 * node's own sign must already point toward the neighbor on those axes.
 */
export function partnerSlot(slot: Slot, offset: Offset): Slot | null {
  const signs = signsOf(slot);
  const out: [Sign | null, Sign | null, Sign | null] = [signs[X], signs[Y], signs[Z]];
  let nonzero = 0;
  for (const ax of AXES) {
    const d = offset[ax];
    if (d === 0) continue;
    if (d !== 1 && d !== -1) throw new RangeError(`offset component must be -1, 0, or 1: ${d}`);
    nonzero++;
    const s = signs[ax];
    if (s === null) return null;
    if ((d > 0 && s !== 1) || (d < 0 && s !== 0)) return null;
    out[ax] = (1 - s) as Sign;
  }
  if (nonzero === 0) return null;
  return slotOf(out);
}

const ALL_OFFSETS: readonly Offset[] = (() => {
  const out: Offset[] = [];
  for (const dz of [-1, 0, 1])
    for (const dy of [-1, 0, 1])
      for (const dx of [-1, 0, 1]) if (dx || dy || dz) out.push([dx, dy, dz]);
  return out;
})();

/** Every neighbor offset at which `slot` has a partner: 1 for a face, 3 for an edge, 7 for a vertex. */
export function linkOffsets(slot: Slot): Offset[] {
  return ALL_OFFSETS.filter((o) => partnerSlot(slot, o) !== null);
}

export function negate(o: Offset): Offset {
  return [-o[0], -o[1], -o[2]];
}
