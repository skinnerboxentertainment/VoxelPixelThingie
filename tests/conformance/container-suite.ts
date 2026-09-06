/**
 * The container contract as executable tests. Run it against any factory:
 *
 *   containerSuite("Grid", (opts) => new Grid(opts));
 *
 * Every number here is one the reference Grid produced in Phases 1 to 6,
 * so a new container passes only by agreeing with the reference.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Container, ContainerFactory } from "../../src/container.ts";
import { RecordingSink, replay } from "../../src/events.ts";
import { renderList } from "../../src/render-list.ts";
import { openScene, SceneSink } from "../../src/scene.ts";
import { EDGE_SLOTS, FACE_SLOTS, VERTEX_SLOTS } from "../../src/slots.ts";
import { MemoryStore } from "../../src/store.ts";
import { isUuidv7 } from "../../src/uuid.ts";
import { sceneDigest } from "../../src/verify.ts";

const RED = { color: 0xff0000 };
const CAM_A = { position: [20, 5, 5] as const };
const CAM_B = { position: [-20, 5, 5] as const };

function fill(factory: ContainerFactory, n: number, opts?: Parameters<ContainerFactory>[0]) {
  const g = factory(opts);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g.add([x, y, z], { emission: RED });
  return g;
}

function lit(g: Container) {
  for (const b of g.bits()) {
    b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
    b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  }
  return g;
}

function counts(g: Container) {
  g.evaluate();
  let faces = 0;
  let asleep = 0;
  for (const b of g.bits()) {
    faces += FACE_SLOTS.filter((s) => b.renderEnabledOf(s)).length;
    if (!b.renderCycle) asleep++;
  }
  return { faces, asleep };
}

const flags = (g: Container) =>
  g.snapshot().map((r) => [r.id, r.renderCycle, r.renderEnabled] as const);

/** The Phase 1 carve sequence with passports, on any container. */
function carve(g: Container) {
  g.wrangle({ actor: "suite", cause: "carve" }, () => {
    for (let x = 0; x < 8; x++) g.setPresent(g.at(x, 3, 3)!, false);
    for (let x = 2; x < 6; x++) g.setPresent(g.at(x, 4, 3)!, false);
  });
  g.setPresent(g.at(5, 3, 3)!, true);
  g.move(g.at(0, 0, 0)!, [10, 10, 10]);
  const b = g.at(7, 7, 7)!;
  b.emit(5, { light: 0.5 });
  b.emit(9, { color: 0x00ff00, data: { tag: "seam" } });
  b.setPassport({ name: "corner", nested: { a: [1, { b: null }] } });
  g.at(0, 7, 0)!.setPassport({ hello: "world" });
  b.annotate("note", "corner");
  g.remove(g.at(7, 0, 0)!);
}

export function containerSuite(name: string, factory: ContainerFactory): void {
  describe(`${name} conformance`, () => {
    test("8^3: 384 faces exposed, 216 bits asleep", () => {
      const g = fill(factory, 8);
      assert.equal(g.size, 512);
      assert.deepEqual(counts(g), { faces: 384, asleep: 216 });
      assert.equal(g.awake.length, 512 - 216);
    });

    test("corner of a 3^3 renders exactly slots [0,2,4,6,10,14,18]", () => {
      const g = fill(factory, 3);
      g.evaluate();
      const c = g.at(0, 0, 0)!;
      const on = c.open.filter((s) => c.renderEnabledOf(s));
      assert.deepEqual(
        [...on].sort((a, b) => a - b),
        [0, 2, 4, 6, 10, 14, 18],
      );
      assert.equal(
        renderList(g.awake).length,
        [...g.bits()].reduce((n, b) => n + b.open.filter((s) => b.renderEnabledOf(s)).length, 0),
      );
    });

    test("straight down an orthographic Z: exactly the nine +Z-side nodes", () => {
      const g = factory();
      const b = g.add([0, 0, 0], { emission: RED });
      g.evaluate({ position: [0, 0, 1e4], towardCamera: [0, 0, 1] });
      const on = b.open.filter((s) => b.renderEnabledOf(s)).sort((a, c) => a - c);
      assert.deepEqual(on, [5, 8, 9, 12, 13, 22, 23, 24, 25]);
    });

    test("removing a neighbor re-exposes the face that was against it", () => {
      const g = factory();
      const a = g.add([0, 0, 0], { emission: RED });
      const b = g.add([1, 0, 0], { emission: RED });
      assert.equal(a.linkCountOf(1), 1);
      assert.equal(a.linkCountOf(25), 1);
      g.evaluate();
      assert.equal(a.renderEnabledOf(1), false);
      assert.ok(g.remove(b));
      assert.equal(a.linkCountOf(1), 0);
      g.evaluate();
      assert.equal(a.renderEnabledOf(1), true);
      assert.equal(g.remove(b), false, "already gone");
    });

    test("cameraMoved visits awake bits and agrees with a full evaluate, before and after removal", () => {
      const g = fill(factory, 4);
      g.evaluate(CAM_A);
      assert.equal(g.awake.length, 64 - 8);
      g.cameraMoved(CAM_B);
      const ref = fill(factory, 4);
      ref.evaluate(CAM_B);
      assert.deepEqual(
        flags(g).map((f) => [f[1], f[2]]),
        flags(ref).map((f) => [f[1], f[2]]),
      );
      g.remove(g.at(1, 1, 1)!);
      g.cameraMoved(CAM_A);
      assert.equal(g.awake.length, 64 - 8 + 3);
      const ref2 = fill(factory, 4);
      ref2.remove(ref2.at(1, 1, 1)!);
      ref2.evaluate(CAM_A);
      assert.deepEqual(
        flags(g).map((f) => [f[1], f[2]]),
        flags(ref2).map((f) => [f[1], f[2]]),
      );
    });

    test("move keeps the id, relinks at the new cell, and re-exposes the old neighbors", () => {
      const g = fill(factory, 3);
      const mid = g.at(1, 0, 0)!;
      const id = mid.id;
      g.move(mid, [5, 0, 0]);
      assert.equal(g.get(id)!.key, "5,0,0");
      assert.equal(g.at(1, 0, 0), undefined);
      assert.equal(
        FACE_SLOTS.reduce((n, s) => n + g.get(id)!.linkCountOf(s), 0),
        0,
      );
      g.evaluate();
      assert.equal(g.at(0, 0, 0)!.renderEnabledOf(1), true);
      assert.throws(() => g.move(g.get(id)!, [0, 0, 0]), /occupied/);
    });

    test("presence through the container: absent drops links, returning relinks", () => {
      const g = fill(factory, 2);
      const a = g.at(0, 0, 0)!;
      g.setPresent(a, false);
      assert.equal(a.present, false);
      assert.equal(a.linkCountOf(1), 0);
      g.evaluate();
      assert.equal(a.renderCycle, false);
      g.setPresent(a, true);
      assert.equal(a.linkCountOf(1), 1);
      assert.equal(g.at(1, 0, 0)!.linkCountOf(0), 1, "the neighbor sees the link too");
    });

    test("ids are unique UUID v7 for bits and the container; keys and lookups agree", () => {
      const g = fill(factory, 3);
      const ids = [...g.bits()].map((b) => b.id);
      assert.equal(new Set(ids).size, 27);
      assert.ok(ids.every(isUuidv7));
      assert.ok(isUuidv7(g.id));
      const b = g.at(1, 2, 0)!;
      assert.equal(g.get(b.id), b);
      assert.equal(b.key, "1,2,0");
      assert.ok(g.has([1, 2, 0]));
      assert.throws(() => g.add([1, 2, 0]), /occupied/);
    });

    test("every mutator emits its event with frame; wrangle stamps actor and cause inside only", () => {
      const sink = new RecordingSink();
      const g = factory({ sink });
      const a = g.add([0, 0, 0], { emission: RED });
      g.add([1, 0, 0]);
      const types = () => sink.events.map((e) => e.type);
      assert.equal(types()[0], "created");
      a.emit(3, { light: 1 });
      assert.equal(types().at(-1), "emitted");
      a.annotate("k", 42);
      assert.equal(types().at(-1), "annotated");
      a.setPassport({ p: 1 });
      assert.equal(types().at(-1), "passport");
      g.wrangle({ actor: "oscar", cause: "test" }, () => a.emit(4, { light: 0.5 }));
      assert.equal(sink.events.at(-1)!.actor, "oscar");
      assert.equal(sink.events.at(-1)!.cause, "test");
      g.setPresent(a, false);
      assert.equal(types().at(-1), "presence");
      g.setPresent(a, true);
      g.move(a, [0, 5, 0]);
      assert.ok(sink.events.some((e) => e.type === "moved" && e.bit === a.id));
      g.remove(a);
      assert.equal(types().at(-1), "destroyed");
      assert.ok(sink.events.every((e) => e.frame === g.id));
      assert.equal(sink.events.filter((e) => e.actor !== undefined).length, 1);
      const seqs = sink.events.map((e) => e.seq);
      assert.deepEqual(
        seqs,
        seqs.map((_, i) => i + 1),
      );
      assert.equal(g.eventCount, sink.events.length);
    });

    test("replay through the factory reproduces the carve sequence", () => {
      const sink = new RecordingSink();
      const live = lit(fill(factory, 8, { sink }));
      carve(live);
      live.evaluate(CAM_A);
      const back = replay(sink.events, { factory });
      back.evaluate(CAM_A);
      assert.equal(back.id, live.id);
      assert.deepEqual(back.snapshot(), live.snapshot());
    });

    test("scene round trip through a store reproduces the carve sequence", async () => {
      const store = new MemoryStore();
      const sink = new SceneSink(store);
      const live = lit(fill(factory, 8, { sink }));
      carve(live);
      await sink.flush();
      const back = await openScene(store, { factory });
      assert.equal(await sceneDigest(back), await sceneDigest(live));
    });
  });
}
