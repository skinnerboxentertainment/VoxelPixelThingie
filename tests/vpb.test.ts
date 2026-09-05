import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_SLOTS, FACE_SLOTS, NODE_COUNT } from "../src/slots.ts";
import { type Camera, VoxelPixelBit } from "../src/vpb.ts";

const RED = { color: 0xff0000 };

function lit(pos: readonly [number, number, number]): VoxelPixelBit {
  const b = new VoxelPixelBit(pos);
  b.emitAll(ALL_SLOTS, RED);
  return b;
}

/** Dense W×H×D block of lit bits, fully linked. */
function block(w: number, h: number, d: number): VoxelPixelBit[] {
  const bits: VoxelPixelBit[] = [];
  for (let z = 0; z < d; z++)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits.push(lit([x, y, z]));
  for (let i = 0; i < bits.length; i++)
    for (let j = i + 1; j < bits.length; j++) bits[i]!.link(bits[j]!);
  return bits;
}

test("a bit has 26 nodes: 6 faces, 12 edges, 8 vertices", () => {
  const b = new VoxelPixelBit([0, 0, 0]);
  assert.equal(b.nodes.length, NODE_COUNT);
  assert.equal(b.nodesOfKind("face").length, 6);
  assert.equal(b.nodesOfKind("edge").length, 12);
  assert.equal(b.nodesOfKind("vertex").length, 8);
});

test("two face-adjacent bits link 9 node pairs: 1 face, 4 edges, 4 vertices", () => {
  const a = lit([0, 0, 0]);
  const b = lit([1, 0, 0]);
  assert.equal(a.link(b), 9);
  assert.equal(a.linkCount(1), 1, "+X face of a");
  assert.equal(b.linkCount(0), 1, "-X face of b");
  assert.equal(a.node(1).links[0]!.slot, 0);
  assert.equal(b.node(0).links[0]!.slot, 1);
  assert.equal(a.nodes.filter((n) => n.links.length).length, 9);
  assert.equal(b.nodes.filter((n) => n.links.length).length, 9);
  assert.equal(a.link(b), 0, "linking twice is a no-op");
});

test("edge-adjacent bits link 3 pairs; vertex-adjacent bits link 1", () => {
  const a = lit([0, 0, 0]);
  assert.equal(a.link(lit([1, 1, 0])), 3);
  assert.equal(lit([0, 0, 0]).link(lit([1, 1, 1])), 1);
  assert.equal(lit([0, 0, 0]).link(lit([2, 0, 0])), 0, "not adjacent");
});

test("center of a 3×3×3 block is enclosed and leaves the render cycle", () => {
  const bits = block(3, 3, 3);
  const center = bits.find((b) => b.id === "1,1,1")!;
  assert.ok(center.isEnclosed);
  assert.equal(
    center.nodes.filter((n) => n.links.length).length,
    26,
    "every node of an interior bit is linked",
  );
  assert.equal(center.linkCount(25), 7, "corner vertex has all 7 links");
  center.evaluate();
  assert.equal(center.renderCycle, false);
  assert.ok(center.nodes.every((n) => !n.renderEnabled));
});

test("a corner bit of the block renders only its 3 outer faces, 3 outer edges, 1 outer vertex", () => {
  const bits = block(3, 3, 3);
  const corner = bits.find((b) => b.id === "0,0,0")!;
  corner.evaluate();
  assert.equal(corner.renderCycle, true);
  const on = corner.nodes.filter((n) => n.renderEnabled).map((n) => n.slot);
  // Outer faces -X -Y -Z, the three edges among them, and vertex 18.
  assert.deepEqual(on, [0, 2, 4, 6, 10, 14, 18]);
});

test("a solid 8×8×8 exposes 384 faces", () => {
  const bits = block(8, 8, 8);
  let faces = 0;
  for (const b of bits) {
    b.evaluate();
    faces += FACE_SLOTS.filter((f) => b.node(f).renderEnabled).length;
  }
  assert.equal(faces, 384);
  assert.equal(bits.filter((b) => !b.renderCycle).length, 216, "6×6×6 interior bits are off");
});

test("removing a neighbor re-exposes the face that was against it", () => {
  const a = lit([0, 0, 0]);
  const b = lit([1, 0, 0]);
  a.link(b);
  a.evaluate();
  assert.equal(a.node(1).renderEnabled, false, "+X hidden while b is there");
  b.setPresent(false);
  assert.equal(a.linkCount(1), 0, "absent bit drops its links");
  assert.ok(a.needsEvaluation);
  a.evaluate();
  assert.equal(a.node(1).renderEnabled, true, "+X visible again");
});

test("silent nodes never render, even when exposed", () => {
  const b = new VoxelPixelBit([0, 0, 0]);
  b.emit(5, { light: 1 });
  b.evaluate();
  assert.equal(b.node(5).renderEnabled, true);
  assert.ok(b.nodes.filter((n) => n.slot !== 5).every((n) => !n.renderEnabled));
});

test("back-facing test: camera on +X sees +X face, not -X", () => {
  const b = lit([0, 0, 0]);
  const cam: Camera = { position: [10, 0, 0] };
  b.evaluate(cam);
  assert.equal(b.node(1).renderEnabled, true, "+X faces the camera");
  assert.equal(b.node(0).renderEnabled, false, "-X faces away");
  assert.equal(b.node(25).renderEnabled, true, "+X+Y+Z vertex leans toward camera");
  assert.equal(b.node(18).renderEnabled, false, "-X-Y-Z vertex leans away");
  assert.equal(b.node(3).renderEnabled, false, "+Y is edge-on: not facing");
});

test("camera tests are cached until onCameraMoved", () => {
  const b = lit([0, 0, 0]);
  const cam: Camera = { position: [10, 0, 0] };
  b.evaluate(cam);
  assert.equal(b.node(1).renderEnabled, true);
  // Move the camera object without telling the bit: cached result stands.
  (cam as { position: [number, number, number] }).position = [-10, 0, 0];
  b.evaluate(cam);
  assert.equal(b.node(1).renderEnabled, true, "stale by design until notified");
  b.onCameraMoved();
  b.evaluate(cam);
  assert.equal(b.node(1).renderEnabled, false);
  assert.equal(b.node(0).renderEnabled, true);
});

test("frustum and coverage failures take the whole bit out of the render cycle", () => {
  const b = lit([0, 0, 0]);
  b.evaluate({ position: [10, 0, 0], containsBit: () => false });
  assert.equal(b.renderCycle, false);
  assert.ok(b.nodes.every((n) => !n.renderEnabled));
  b.onCameraMoved();
  b.evaluate({ position: [10, 0, 0], coversPixel: () => false });
  assert.equal(b.renderCycle, false);
});

test("an enclosed bit never runs camera tests", () => {
  const bits = block(3, 3, 3);
  const center = bits.find((b) => b.id === "1,1,1")!;
  let asked = 0;
  center.evaluate({
    position: [10, 10, 10],
    containsBit: () => {
      asked++;
      return true;
    },
  });
  assert.equal(asked, 0);
  assert.equal(center.renderCycle, false);
});
