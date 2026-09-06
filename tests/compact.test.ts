import assert from "node:assert/strict";
import { test } from "node:test";
import { compact, compactLedger } from "../src/compact.ts";
import type { BitEvent } from "../src/events.ts";
import { Grid } from "../src/grid.ts";

const gridFactory = (o?: ConstructorParameters<typeof Grid>[0]) => new Grid(o);

import { ledgerPath, openScene, parseLedger, readManifest, SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
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

async function buildScene(store: MemoryStore): Promise<Grid> {
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
  b.setPassport({ name: "corner", nested: { a: [1, { b: null }] } });
  live.at(0, 7, 0)!.setPassport({ hello: "world" });
  b.annotate("note", "corner");
  live.remove(live.at(7, 0, 0)!);
  await sink.flush();
  return live;
}

test("oracle: compact with tail 8, openScene, snapshot equals the uncompacted import", async () => {
  const store = new MemoryStore();
  const live = await buildScene(store);
  const full = await openScene(store, { factory: gridFactory });

  const report = await compact(store, { tail: 8, now: () => 5 });
  assert.ok(report.dropped > 0);
  assert.equal(report.bits, 512);
  const manifest = (await readManifest(store))!;
  assert.equal(manifest.compacted, true);
  assert.equal(manifest.scene, live.id);

  // A heavily linked bit's ledger is at most the tail.
  const inner = live.at(4, 4, 4) ?? live.at(1, 1, 1)!;
  const lines = parseLedger(await store.read(ledgerPath(inner.id)));
  assert.ok(lines.length <= 8, `ledger has ${lines.length} lines`);
  assert.ok(lines.every((e) => e.type !== "linked" && e.type !== "unlinked"));

  const back = await openScene(store, { factory: gridFactory });
  assert.equal(back.id, live.id);
  assert.deepEqual(snapshot(back), snapshot(full));
  assert.deepEqual(snapshot(back), snapshot(live));
  assert.deepEqual(flags(back), flags(live));
});

test("compaction after the passport: a tail beyond the snapshot is applied on open", async () => {
  const store = new MemoryStore();
  const live = await buildScene(store);
  await compact(store, { tail: 2 });
  // Now write more events through a fresh sink onto the compacted store; the
  // sink has no passport projection for these bits, so it must rebuild from the file.
  // (Not supported in v0.4: a sink is bound to a scene from its start.) Instead,
  // simulate a tail by hand: append an emitted event after the passport seq.
  const target = live.at(7, 7, 7)!;
  const events = parseLedger(await store.read(ledgerPath(target.id)));
  const last = events[events.length - 1]!;
  const extra: BitEvent = {
    type: "emitted",
    slot: 0,
    emission: { color: 0x123456 },
    bit: target.id,
    seq: last.seq + 1000,
    time: last.time + 1,
    frame: live.id,
  };
  await store.append(ledgerPath(target.id), `${JSON.stringify(extra)}\n`);
  const back = await openScene(store, { factory: gridFactory });
  assert.deepEqual(back.get(target.id)!.node(0).emission, { color: 0x123456 });
  assert.deepEqual(
    back.get(target.id)!.passport,
    target.passport,
    "passport survives with the tail applied",
  );
});

test("compactLedger keeps events beyond the passport and the last tail below it", () => {
  const mk = (seq: number, type: BitEvent["type"] = "annotated"): BitEvent =>
    ({ type, key: "k", value: seq, bit: "b", seq, time: 0, frame: "f" }) as BitEvent;
  const events = [
    mk(1, "created" as never),
    mk(2, "linked" as never),
    mk(3),
    mk(4),
    mk(5),
    mk(6),
    mk(7),
  ];
  const passport = { seq: 5 } as never;
  const kept = compactLedger(events, passport, { tail: 2, dropLinks: true });
  assert.deepEqual(
    kept.map((e) => e.seq),
    [4, 5, 6, 7],
    "two below the passport, everything above it, link dropped",
  );
  assert.deepEqual(
    compactLedger(events, undefined, { tail: 1, dropLinks: false }).map((e) => e.seq),
    [1, 2, 3, 4, 5, 6, 7],
    "no passport: nothing is derivable, nothing dropped",
  );
});
