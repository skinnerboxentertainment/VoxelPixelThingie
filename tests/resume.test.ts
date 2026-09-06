import assert from "node:assert/strict";
import { test } from "node:test";
import { compact } from "../src/compact.ts";
import { Grid } from "../src/grid.ts";
import { ledgerPath, openScene, parseLedger, readManifest, SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS, VERTEX_SLOTS } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
import type { VoxelPixelBit } from "../src/vpb.ts";

const RED = { color: 0xff0000 };

function snapshot(g: Grid) {
  return [...g.bits()]
    .map((b: VoxelPixelBit) => ({
      id: b.id,
      key: b.key,
      present: b.present,
      passport: b.passport,
      emissions: b.nodes.map((n) => n.emission),
      links: b.nodes.map((n) => n.links.map((l) => `${l.bit.id}:${l.slot}`).sort()),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function seed(store: MemoryStore): Promise<Grid> {
  let t = 1000;
  const sink = new SceneSink(store, { now: () => ++t });
  const live = Grid.fill(4, 4, 4, { emission: RED, sink, now: () => ++t });
  for (const b of live.bits()) {
    b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
    b.emitAll(VERTEX_SLOTS, { color: 0xffffff, light: 1 });
  }
  live.at(3, 3, 3)!.setPassport({ seeded: true });
  await sink.flush();
  return live;
}

async function allSeqs(store: MemoryStore): Promise<number[]> {
  const out: number[] = [];
  for (const id of await store.list("bits")) {
    for (const e of parseLedger(await store.read(ledgerPath(id)))) out.push(e.seq);
  }
  return out;
}

test("oracle: resume, carve two more, flush, reopen: equal, no duplicate lines, seq monotonic", async () => {
  const store = new MemoryStore();
  await seed(store);
  const m0 = (await readManifest(store))!;
  const linesBefore = (await allSeqs(store)).length;

  const sink = await SceneSink.resume(store);
  const g = await openScene(store, { attach: sink });
  assert.equal((await allSeqs(store)).length, linesBefore, "opening wrote nothing");

  g.wrangle({ actor: "test", cause: "carve two more" }, () => {
    g.setPresent(g.at(1, 1, 1)!, false);
    g.setPresent(g.at(2, 2, 2)!, false);
    g.at(0, 0, 0)!.setPassport({ resumed: true });
  });
  await sink.flush();

  const seqs = await allSeqs(store);
  assert.equal(new Set(seqs).size, seqs.length, "no duplicated ledger lines");
  assert.ok(
    Math.min(...seqs.filter((s) => s > m0.seq)) === m0.seq + 1,
    "new events continue the sequence",
  );
  const m1 = (await readManifest(store))!;
  assert.ok(m1.seq > m0.seq);
  assert.equal(m1.scene, m0.scene);
  assert.equal(m1.created, m0.created, "created is preserved");
  assert.equal(m1.bits, 64);
  assert.deepEqual(m1.ids?.length, 64);

  const again = await openScene(store);
  assert.deepEqual(snapshot(again), snapshot(g));
  assert.equal(again.get(g.at(0, 0, 0)!.id)!.passport.resumed, true);
  assert.equal(again.at(1, 1, 1)!.present, false);
});

test("resume after compaction: projection comes from passports plus the tail", async () => {
  const store = new MemoryStore();
  const live = await seed(store);
  await compact(store, { tail: 2 });
  const sink = await SceneSink.resume(store);
  const g = await openScene(store, { attach: sink });
  assert.deepEqual(snapshot(g), snapshot(live));
  g.at(3, 3, 3)!.setPassport({ seeded: true, more: 1 });
  await sink.flush();
  const again = await openScene(store);
  assert.deepEqual(again.at(3, 3, 3)!.passport, { seeded: true, more: 1 });
  assert.equal(
    (await readManifest(store))!.compacted,
    true,
    "compacted flag survives further writes",
  );
});

test("attach without resume: a fresh sink after replay records only new events", async () => {
  const store = new MemoryStore();
  await seed(store);
  const other = new MemoryStore();
  const fresh = new SceneSink(other);
  const g = await openScene(store, { attach: fresh });
  await fresh.flush();
  assert.equal((await other.list("bits")).length, 0, "nothing replayed into the fresh sink");
  g.at(0, 0, 0)!.annotate("k", 1);
  await assert.rejects(fresh.flush(), /before its created event/);
  const written = await other.list("bits");
  assert.equal(written.length, 0, "a batch that cannot be projected writes nothing");
});

test("resume refuses a store without a manifest", async () => {
  await assert.rejects(SceneSink.resume(new MemoryStore()), /not a scene/);
});
