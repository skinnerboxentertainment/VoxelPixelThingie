import assert from "node:assert/strict";
import { test } from "node:test";
import type { Container, ContainerFactory } from "../../src/container.ts";
import { FlatGrid } from "../../src/flat-grid.ts";
import { Grid } from "../../src/grid.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../../src/slots.ts";
import { sceneDigest } from "../../src/verify.ts";
import { containerSuite } from "./container-suite.ts";

containerSuite("FlatGrid", (opts) => new FlatGrid(opts));

/** The demo's reference scene with deterministic ids, on any container. */
function reference(factory: ContainerFactory, size = 8): Container {
  let n = 0;
  const g = factory({ id: "reference", mintId: () => `bit-${String(++n).padStart(4, "0")}` });
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const b = g.add([x, y, z], { emission: { color: 0x1f6feb, light: 0.6 } });
        b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
        b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
      }
  const from = size - 3;
  for (let z = from; z < size; z++)
    for (let y = from; y < size; y++) for (let x = from; x < size; x++) g.remove(g.at(x, y, z)!);
  g.at(0, 0, 0)!.setPassport({ name: "origin" });
  return g;
}

test("oracle: the reference scene has the same digest from Grid and FlatGrid", async () => {
  const a = reference((o) => new Grid(o));
  const b = reference((o) => new FlatGrid(o));
  assert.equal(await sceneDigest(b), await sceneDigest(a));
  const ortho = { position: [0, 0, 1e4] as const, towardCamera: [0, 0, 1] as const };
  assert.equal(await sceneDigest(b, ortho), await sceneDigest(a, ortho));
});

test("FlatGrid emits no link events and the same count of every other type as Grid", () => {
  const seen = { grid: new Map<string, number>(), flat: new Map<string, number>() };
  const tally = (m: Map<string, number>) => ({
    record: (e: { type: string }) => m.set(e.type, (m.get(e.type) ?? 0) + 1),
  });
  reference((o) => new Grid({ ...o, sink: tally(seen.grid) }), 4);
  reference((o) => new FlatGrid({ ...o, sink: tally(seen.flat) }), 4);
  assert.ok((seen.grid.get("linked") ?? 0) > 0);
  assert.equal(seen.flat.get("linked"), undefined);
  assert.equal(seen.flat.get("unlinked"), undefined);
  for (const t of ["created", "emitted", "destroyed", "passport"]) {
    assert.equal(seen.flat.get(t), seen.grid.get(t), t);
  }
});

test("FlatGrid grows past its initial capacity without losing rows", () => {
  const g = new FlatGrid();
  for (let i = 0; i < 500; i++) g.add([i, 0, 0], { emission: { color: 1 } });
  assert.equal(g.size, 500);
  g.evaluate();
  assert.equal(g.at(250, 0, 0)!.linkCountOf(1), 1);
  assert.equal(g.at(499, 0, 0)!.linkCountOf(1), 0);
  assert.equal(g.awake.length, 500);
});
