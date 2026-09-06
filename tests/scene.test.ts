import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Grid } from "../src/grid.ts";

const gridFactory = (o?: ConstructorParameters<typeof Grid>[0]) => new Grid(o);

import {
  ledgerPath,
  openScene,
  PASSPORT_LIMIT_BYTES,
  type PassportFile,
  parseLedger,
  passportPath,
  readManifest,
  SceneSink,
} from "../src/scene.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";
import { type FileStore, MemoryStore } from "../src/store.ts";
import { NodeFsStore } from "../src/store-node.ts";
import type { VoxelPixelBit } from "../src/vpb.ts";

const RED = { color: 0xff0000 };
const CAMERA = { position: [20, 10, 30] as const };

function snapshot(g: Grid) {
  return [...g.bits()]
    .map((b: VoxelPixelBit) => ({
      id: b.id,
      key: b.key,
      present: b.present,
      color: b.color,
      passport: b.passport,
      emissions: b.nodes.map((n) => n.emission),
      links: b.nodes.map((n) => n.links.map((l) => `${l.bit.id}:${l.slot}`).sort()),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function flags(g: Grid) {
  g.evaluate(CAMERA);
  return [...g.bits()]
    .map((b) => [b.id, b.renderCycle, b.nodes.map((n) => n.renderEnabled)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The Phase 1 carve sequence plus passports, recorded through a SceneSink. */
async function buildScene(store: FileStore): Promise<{ live: Grid; sink: SceneSink }> {
  let t = 1000;
  const sink = new SceneSink(store, { now: () => ++t });
  const live = Grid.fill(8, 8, 8, { emission: RED, sink, now: () => ++t });
  for (const b of live.bits()) {
    b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
    b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  }
  live.wrangle({ actor: "test", cause: "carve" }, () => {
    for (let x = 0; x < 8; x++) live.setPresent(live.at(x, 3, 3)!, false);
    for (let x = 2; x < 6; x++) live.setPresent(live.at(x, 4, 3)!, false);
  });
  live.setPresent(live.at(5, 3, 3)!, true);
  live.move(live.at(0, 0, 0)!, [10, 10, 10]);
  const b = live.at(7, 7, 7)!;
  b.emit(5, { light: 0.5 });
  b.emit(9, { color: 0x00ff00, data: { tag: "seam" } });
  b.setPassport({ name: "corner", tags: ["seam"], nested: { a: { b: { c: [1, null] } } } });
  live.at(0, 7, 0)!.setPassport({ hello: "world" });
  b.annotate("note", "corner");
  live.remove(live.at(7, 0, 0)!);
  await sink.flush();
  return { live, sink };
}

test("round trip through a MemoryStore reproduces every bit and every render flag", async () => {
  const store = new MemoryStore();
  const { live } = await buildScene(store);
  const back = await openScene(store, { factory: gridFactory });
  assert.equal(back.id, live.id, "same frame");
  assert.equal(back.size, live.size);
  assert.deepEqual(snapshot(back), snapshot(live));
  assert.deepEqual(flags(back), flags(live));
});

test("round trip through a real folder, with the SPEC 10 layout and write ordering", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "vpb-scene-"));
  const store = new NodeFsStore(dir);
  const { live } = await buildScene(store);

  const manifest = (await readManifest(store))!;
  assert.equal(manifest.format, "vpb-scene/1");
  assert.equal(manifest.scene, live.id);
  assert.equal(manifest.bits, live.size, "manifest counts bits that were not destroyed");
  assert.equal(manifest.compacted, undefined);
  const ids = await store.list("bits");
  assert.equal(ids.length, 512, "destroyed bits keep their folder");
  for (const id of ids) {
    const p = JSON.parse((await store.read(passportPath(id)))!) as PassportFile;
    const events = parseLedger(await store.read(ledgerPath(id)));
    assert.equal(p.seq, events[events.length - 1]!.seq, "passport is at the ledger head");
    assert.ok(p.seq <= manifest.seq);
  }
  const destroyed = ids.find((id) => !live.get(id))!;
  const dp = JSON.parse((await store.read(passportPath(destroyed)))!) as PassportFile;
  assert.equal(dp.destroyed, true);

  const back = await openScene(store, { factory: gridFactory });
  assert.deepEqual(snapshot(back), snapshot(live));
  assert.deepEqual(flags(back), flags(live));
  await fs.rm(dir, { recursive: true, force: true });
});

test("a torn last line is discarded and the bit is at its previous seq", async () => {
  const store = new MemoryStore();
  const { live } = await buildScene(store);
  const victim = live.at(7, 7, 7)!;
  const before = snapshot(live).find((s) => s.id === victim.id)!;
  // Append a half-written event, as a crash mid-write would leave it.
  const half = JSON.stringify({
    type: "emitted",
    slot: 5,
    emission: { color: 1 },
    bit: victim.id,
    seq: 999999,
    time: 0,
    frame: live.id,
  }).slice(0, 40);
  await store.append(ledgerPath(victim.id), half);
  const back = await openScene(store, { factory: gridFactory });
  const after = snapshot(back).find((s) => s.id === victim.id)!;
  assert.deepEqual(after, before, "the torn event had no effect");
});

test("parseLedger handles empty, trailing newline, and torn lines", () => {
  assert.deepEqual(parseLedger(undefined), []);
  assert.deepEqual(parseLedger(""), []);
  const a = '{"type":"annotated","key":"k","value":1,"bit":"b","seq":1,"time":0,"frame":"f"}';
  assert.equal(parseLedger(`${a}\n`).length, 1);
  assert.equal(parseLedger(`${a}\n${a}\n{"type":"ann`).length, 2);
  assert.throws(
    () => parseLedger(`{"broken\n${a}\n`),
    SyntaxError,
    "a torn line that is not last is an error",
  );
});

test("the reference sink refuses an oversized passport and the bit is unchanged", async () => {
  const store = new MemoryStore();
  const sink = new SceneSink(store);
  const g = new Grid({ sink });
  const b = g.add([0, 0, 0]);
  b.setPassport({ ok: true });
  const big = { blob: "x".repeat(PASSPORT_LIMIT_BYTES) };
  assert.throws(() => b.setPassport(big), /limit is/);
  assert.deepEqual(b.passport, { ok: true });
  await sink.flush();
  const events = parseLedger(await store.read(ledgerPath(b.id)));
  assert.equal(events.filter((e) => e.type === "passport").length, 1);
});

test("flush surfaces a store failure", async () => {
  const failing: FileStore = {
    read: async () => undefined,
    write: async () => {},
    append: async () => {
      throw new Error("disk full");
    },
    list: async () => [],
  };
  const sink = new SceneSink(failing);
  const g = new Grid({ sink });
  g.add([0, 0, 0]);
  await assert.rejects(sink.flush(), /disk full/);
});

test("openScene without a manifest is refused", async () => {
  await assert.rejects(openScene(new MemoryStore()), /not a scene/);
});
