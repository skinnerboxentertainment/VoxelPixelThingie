/**
 * Searchable memory (PLAN-4.md Phase 20): one call answers "slot 1, any
 * actor, any time"; text and structure compose; the index rebuilds to the
 * same bytes and notices when the scene moved on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceScene } from "../demo/shared/scene.ts";
import { searchWorkload } from "../src/actor.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import {
  buildIndex,
  INDEX_PATH,
  indexFromText,
  indexToText,
  loadOrBuildIndex,
  MemoryIndex,
  tokenize,
  tokensOf,
} from "../src/memory.ts";
import { SceneSink } from "../src/scene.ts";
import { MemoryStore } from "../src/store.ts";

async function scene() {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem, {
    now: (() => {
      let t = 1_700_000_000_000;
      return () => (t += 1000);
    })(),
  });
  const recorder = new RecordingSink();
  const grid = referenceScene(8, new TeeSink([sink, recorder]));
  const touched = [grid.at(0, 0, 0)!, grid.at(1, 0, 0)!, grid.at(2, 0, 0)!];
  grid.wrangle({ actor: "oscar", cause: "carve tunnel" }, () => {
    for (const b of touched) b.emit(1, { color: 0xff0000, light: 1 });
  });
  grid.wrangle({ actor: "oscar", cause: "name it" }, () =>
    grid.at(0, 0, 0)!.setPassport({ name: "origin", tags: ["first", "corner"] }),
  );
  await sink.flush();
  return { mem, sink, recorder, grid, touched };
}

test("tokens: words and numbers, lowercase, two characters or more; an event contributes its cause, annotation, and passport text", () => {
  assert.deepEqual(tokenize("Carve the Tunnel, slot-1: x"), ["carve", "the", "tunnel", "slot"]);
  const base = { bit: "b", seq: 1, time: 0, frame: "f" } as const;
  assert.deepEqual(
    tokensOf({ ...base, type: "emitted", slot: 1, emission: {}, cause: "Paint it Red" }),
    ["it", "paint", "red"],
  );
  assert.deepEqual(
    tokensOf({
      ...base,
      type: "annotated",
      key: "job:request",
      value: { id: "j1", kind: "links" },
    }),
    ["id", "j1", "job", "kind", "links", "request"],
  );
  assert.deepEqual(tokensOf({ ...base, type: "passport", passport: { name: "origin", n: 42 } }), [
    "42",
    "name",
    "origin",
  ]);
  assert.deepEqual(tokensOf({ ...base, type: "destroyed" }), []);
});

test("slot 1, any actor, any time: one call, bit, seq, actor, and time per hit, under 50 ms on the reference scene", async () => {
  const { mem, grid, touched } = await scene();
  const index = await buildIndex(mem);
  assert.equal(index.scene, grid.id);
  const r = index.search({ slot: 1, type: "emitted" });
  assert.equal(r.total, 3);
  assert.deepEqual(r.hits.map((h) => h.bit).sort(), touched.map((b) => b.id).sort());
  for (const h of r.hits) {
    assert.equal(h.actor, "oscar");
    assert.equal(h.cause, "carve tunnel");
    assert.ok(h.seq > 0);
    assert.ok(h.time >= 1_700_000_000_000);
  }
  assert.ok(r.ms < 50, `${r.ms.toFixed(2)} ms`);
  // Text and structure compose.
  assert.equal(index.search({ text: "carve tunnel" }).total, 3);
  assert.equal(index.search({ text: "tunnel", bit: touched[0]!.id }).total, 1);
  assert.equal(index.search({ text: "TUNNEL carve", actor: "nobody" }).total, 0);
  const named = index.search({ text: "origin" });
  assert.equal(named.total, 1);
  assert.equal(named.hits[0]!.type, "passport");
  assert.equal(named.hits[0]!.bit, touched[0]!.id);
  assert.equal(index.search({ text: "corner first" }).total, 1, "passport array values are text");
  assert.equal(index.search({ text: "no such words" }).total, 0);
  // Time bounds and limits.
  const all = index.search({ limit: 100000 });
  assert.equal(all.total, index.events);
  const first = all.hits[0]!;
  assert.equal(index.search({ to: first.time, bit: first.bit }).total, 1);
  assert.equal(
    index.search({ from: first.time + 1, bit: first.bit }).total,
    all.hits.filter((h) => h.bit === first.bit).length - 1,
  );
  assert.equal(index.search({ limit: 5 }).hits.length, 5);
  assert.equal(index.search({ type: "created" }).total, 512);
  assert.equal(index.search({ type: "destroyed" }).total, 27);
});

test("the index rebuilds to the same bytes, survives a round trip, is written beside the manifest, and is rebuilt when the scene moves on", async () => {
  const { mem, grid, sink } = await scene();
  const a = indexToText(await buildIndex(mem));
  const b = indexToText(await buildIndex(mem));
  assert.equal(a, b);
  const back = indexFromText(a);
  assert.equal(indexToText(back), a);
  assert.equal(back.search({ text: "tunnel" }).total, 3);

  const first = await loadOrBuildIndex(mem);
  assert.equal(first.rebuilt, true);
  assert.equal(await mem.read(INDEX_PATH), a);
  const second = await loadOrBuildIndex(mem);
  assert.equal(second.rebuilt, false);
  assert.equal(second.index.seq, first.index.seq);

  // The scene moves on: the stored index is stale and is rebuilt.
  grid.wrangle({ actor: "oscar", cause: "later" }, () => grid.at(3, 0, 0)!.emit(1, { light: 0 }));
  await sink.flush();
  const third = await loadOrBuildIndex(mem);
  assert.equal(third.rebuilt, true);
  assert.equal(third.index.search({ slot: 1, type: "emitted" }).total, 4);
  assert.notEqual(await mem.read(INDEX_PATH), a);

  // A live index extends without a rebuild.
  const live = MemoryIndex.fromFile(third.index.toFile());
  const seqBefore = live.seq;
  grid.wrangle({ actor: "oscar", cause: "live" }, () => grid.at(4, 0, 0)!.emit(1, { light: 0 }));
  await sink.flush();
  const ledger = (await import("../src/scene.ts")).parseLedger(
    await mem.read(`bits/${grid.at(4, 0, 0)!.id}/events.jsonl`),
  );
  for (const e of ledger) if (e.seq > seqBefore) live.add(e);
  assert.equal(live.search({ slot: 1, type: "emitted" }).total, 5);
  assert.ok(live.seq > seqBefore);
});

test("the search workload: a bit answers a query about its own history, and the audit recomputes the answer without the index", async () => {
  const { grid, recorder, touched } = await scene();
  const bit = touched[1]!;
  const outcome = await searchWorkload(
    bit,
    { id: "s1", kind: "search", params: { text: "tunnel" } },
    {
      grid,
      history: () => recorder.events,
    },
  );
  assert.equal(outcome.passed, true, outcome.detail ?? "");
  const value = outcome.value as { total: number; hits: { bit: string; slot?: number }[] };
  assert.equal(value.total, 1);
  assert.equal(value.hits[0]!.bit, bit.id);
  assert.equal(value.hits[0]!.slot, 1);
  const none = await searchWorkload(
    bit,
    { id: "s2", kind: "search", params: { text: "origin" } },
    {
      grid,
      history: () => recorder.events,
    },
  );
  assert.equal(
    (none.value as { total: number }).total,
    0,
    "another bit's passport is not this bit's memory",
  );
  const bad = await searchWorkload(
    bit,
    { id: "s3", kind: "search", params: { slot: "one" } },
    {
      grid,
      history: () => recorder.events,
    },
  );
  assert.equal(bad.passed, false);
});
