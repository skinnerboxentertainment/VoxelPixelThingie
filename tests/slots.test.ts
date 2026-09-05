/**
 * Oracle: the tables printed in SPEC.md §5.4–5.7 and the fan-out of §4.2.
 * These tests hardcode the spec's numbers so that a drift in the formulas
 * shows up as a failure here, not as a silent change of meaning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_SLOTS,
  EDGE_SLOTS,
  FACE_SLOTS,
  VERTEX_SLOTS,
  edgeSlot,
  edgeVertices,
  faceEdges,
  faceSlot,
  kindOf,
  linkOffsets,
  negate,
  nodeVertices,
  outwardOf,
  partnerSlot,
  signsOf,
  slotOf,
  vertexSlot,
  X,
  Y,
  Z,
} from "../src/slots.ts";

test("face slots follow §5.4", () => {
  assert.equal(faceSlot(X, 0), 0);
  assert.equal(faceSlot(X, 1), 1);
  assert.equal(faceSlot(Y, 0), 2);
  assert.equal(faceSlot(Y, 1), 3);
  assert.equal(faceSlot(Z, 0), 4);
  assert.equal(faceSlot(Z, 1), 5);
});

test("edge slots and endpoints follow §5.5", () => {
  // slot: [axis, signA, signB, endpoints]
  const table: Record<number, [0 | 1 | 2, 0 | 1, 0 | 1, number[]]> = {
    6: [X, 0, 0, [18, 19]],
    7: [X, 1, 0, [20, 21]],
    8: [X, 0, 1, [22, 23]],
    9: [X, 1, 1, [24, 25]],
    10: [Y, 0, 0, [18, 20]],
    11: [Y, 1, 0, [19, 21]],
    12: [Y, 0, 1, [22, 24]],
    13: [Y, 1, 1, [23, 25]],
    14: [Z, 0, 0, [18, 22]],
    15: [Z, 1, 0, [19, 23]],
    16: [Z, 0, 1, [20, 24]],
    17: [Z, 1, 1, [21, 25]],
  };
  for (const [slotStr, [axis, a, b, ends]] of Object.entries(table)) {
    const slot = Number(slotStr);
    assert.equal(edgeSlot(axis, a, b), slot);
    assert.deepEqual(edgeVertices(slot), ends, `edge ${slot} endpoints`);
  }
});

test("vertex slots follow §5.6", () => {
  let slot = 18;
  for (const z of [0, 1] as const)
    for (const y of [0, 1] as const)
      for (const x of [0, 1] as const) assert.equal(vertexSlot(x, y, z), slot++);
});

test("face incidence follows §5.7", () => {
  const table: Record<number, [number[], number[]]> = {
    0: [[10, 12, 14, 16], [18, 20, 22, 24]],
    1: [[11, 13, 15, 17], [19, 21, 23, 25]],
    2: [[6, 8, 14, 15], [18, 19, 22, 23]],
    3: [[7, 9, 16, 17], [20, 21, 24, 25]],
    4: [[6, 7, 10, 11], [18, 19, 20, 21]],
    5: [[8, 9, 12, 13], [22, 23, 24, 25]],
  };
  for (const [slotStr, [edges, verts]] of Object.entries(table)) {
    const face = Number(slotStr);
    assert.deepEqual(faceEdges(face), edges, `face ${face} edges`);
    assert.deepEqual(nodeVertices(face), verts, `face ${face} vertices`);
  }
});

test("kind partition is 6 / 12 / 8", () => {
  assert.equal(FACE_SLOTS.length, 6);
  assert.equal(EDGE_SLOTS.length, 12);
  assert.equal(VERTEX_SLOTS.length, 8);
  assert.ok(FACE_SLOTS.every((s) => kindOf(s) === "face"));
  assert.ok(EDGE_SLOTS.every((s) => kindOf(s) === "edge"));
  assert.ok(VERTEX_SLOTS.every((s) => kindOf(s) === "vertex"));
  assert.throws(() => kindOf(26));
  assert.throws(() => kindOf(-1));
});

test("signsOf and slotOf are inverses on all 26 slots", () => {
  for (const s of ALL_SLOTS) assert.equal(slotOf(signsOf(s)), s);
});

test("link fan-out is 1 / 3 / 7 per §4.2", () => {
  for (const s of FACE_SLOTS) assert.equal(linkOffsets(s).length, 1);
  for (const s of EDGE_SLOTS) assert.equal(linkOffsets(s).length, 3);
  for (const s of VERTEX_SLOTS) assert.equal(linkOffsets(s).length, 7);
});

test("partner rule is symmetric: partner of partner across the reverse offset is self", () => {
  for (const s of ALL_SLOTS) {
    for (const o of linkOffsets(s)) {
      const p = partnerSlot(s, o);
      assert.notEqual(p, null);
      assert.equal(partnerSlot(p!, negate(o)), s, `slot ${s} via ${o}`);
      assert.equal(kindOf(p!), kindOf(s));
    }
  }
});

test("partner rule examples from §7", () => {
  assert.equal(partnerSlot(1, [1, 0, 0]), 0);
  assert.equal(partnerSlot(9, [0, 1, 0]), 8);
  assert.equal(partnerSlot(9, [0, 0, 1]), 7);
  assert.equal(partnerSlot(9, [0, 1, 1]), 6);
  assert.equal(partnerSlot(1, [-1, 0, 0]), null, "face +X has no partner toward -X");
  assert.equal(partnerSlot(9, [1, 0, 0]), null, "edge along X has no partner along X");
  assert.equal(partnerSlot(25, [0, 0, 0]), null);
});

test("vertex 25 (+X +Y +Z) links to all seven positive-octant offsets", () => {
  const offsets = linkOffsets(25).map((o) => o.join(",")).sort();
  assert.deepEqual(
    offsets,
    ["0,0,1", "0,1,0", "0,1,1", "1,0,0", "1,0,1", "1,1,0", "1,1,1"],
  );
});

test("outward direction has the sign pattern of the node", () => {
  assert.deepEqual(outwardOf(0), [-1, 0, 0]);
  assert.deepEqual(outwardOf(5), [0, 0, 1]);
  assert.deepEqual(outwardOf(9), [0, 1, 1]);
  assert.deepEqual(outwardOf(18), [-1, -1, -1]);
});
