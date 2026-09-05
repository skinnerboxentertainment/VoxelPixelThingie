import assert from "node:assert/strict";
import { test } from "node:test";
import { Grid } from "../src/grid.ts";
import { renderList } from "../src/render-list.ts";
import { FACE_SLOTS } from "../src/slots.ts";

const RED = { color: 0xff0000 };

test("Grid.fill(8,8,8) matches the pairwise oracle: 384 faces, 216 asleep", () => {
  const g = Grid.fill(8, 8, 8, { emission: RED });
  assert.equal(g.size, 512);
  g.evaluate();
  let faces = 0;
  let asleep = 0;
  for (const b of g.bits()) {
    faces += FACE_SLOTS.filter((f) => b.node(f).renderEnabled).length;
    if (!b.renderCycle) asleep++;
  }
  assert.equal(faces, 384);
  assert.equal(asleep, 216);
});

test("renderList length equals the count of enabled nodes", () => {
  const g = Grid.fill(3, 3, 3, { emission: RED });
  g.evaluate();
  let enabled = 0;
  for (const b of g.bits())
    if (b.renderCycle) enabled += b.nodes.filter((n) => n.renderEnabled).length;
  const list = renderList(g.bits());
  assert.equal(list.length, enabled);
  assert.ok(list.every((r) => r.emission.color === 0xff0000));
  const corner = list.filter((r) => r.bit.key === "0,0,0").map((r) => r.slot);
  assert.deepEqual(corner, [0, 2, 4, 6, 10, 14, 18]);
});

test("ids are unique, minted by the grid, and looked up both ways", () => {
  const g = Grid.fill(4, 4, 4);
  const ids = new Set([...g.bits()].map((b) => b.id));
  assert.equal(ids.size, 64);
  const b = g.at(1, 2, 3)!;
  assert.equal(g.get(b.id), b);
  assert.throws(() => g.add([1, 2, 3]), /occupied/);
  assert.throws(() => g.add([9, 9, 9], { id: b.id }), /already/);
});

test("add links to every present neighbor; remove unlinks them", () => {
  const g = new Grid();
  const a = g.add([0, 0, 0]);
  const b = g.add([1, 0, 0]);
  const c = g.add([1, 1, 1]);
  assert.equal(a.linkCount(1), 1, "a +X face to b");
  assert.equal(a.linkCount(25), 2, "a +X+Y+Z vertex to b and c");
  assert.ok(g.remove(b));
  assert.equal(a.linkCount(1), 0);
  assert.equal(a.linkCount(25), 1, "only c remains");
  assert.equal(g.size, 2);
  assert.equal(g.remove(b), false, "already gone");
  assert.equal(c.linkCount(18), 1);
});

test("move keeps the id, relinks at the new cell, and re-exposes the old neighbors", () => {
  const g = Grid.fill(3, 1, 1, { emission: RED });
  const mid = g.at(1, 0, 0)!;
  const id = mid.id;
  g.move(mid, [5, 0, 0]);
  assert.equal(mid.id, id);
  assert.equal(mid.key, "5,0,0");
  assert.equal(g.at(1, 0, 0), undefined);
  assert.equal(g.get(id), mid);
  assert.equal(mid.nodes.filter((n) => n.links.length).length, 0, "nothing at 5,0,0 to link");
  g.evaluate();
  assert.equal(g.at(0, 0, 0)!.node(1).renderEnabled, true, "+X of the left bit re-exposed");
  assert.throws(() => g.move(mid, [0, 0, 0]), /occupied/);
});

test("setPosition refuses while linked", () => {
  const g = Grid.fill(2, 1, 1);
  assert.throws(() => g.at(0, 0, 0)!.setPosition([7, 7, 7]), /unlink/);
});
