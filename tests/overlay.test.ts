import assert from "node:assert/strict";
import { test } from "node:test";
import { FlatGrid } from "../src/flat-grid.ts";
import { PackedStore, packScene, packToText } from "../src/pack.ts";
import { ledgerPath, openScene, passportPath, SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
import { OverlayStore } from "../src/store-overlay.ts";
import { sceneDigest } from "../src/verify.ts";

async function seed(store: MemoryStore) {
  const sink = new SceneSink(store);
  const g = FlatGrid.fill(3, 3, 3, { emission: { color: 0x1f6feb }, sink });
  for (const b of g.bits()) b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
  await sink.flush();
  return g;
}

test("reads fall through, writes go up, the first append copies the base text up", async () => {
  const base = new MemoryStore();
  const top = new MemoryStore();
  await base.write("a.txt", "base-a");
  await base.write("bits/x/events.jsonl", "line1\n");
  const o = OverlayStore.fresh(base, top);
  assert.equal(await o.read("a.txt"), "base-a");
  await o.write("a.txt", "top-a");
  assert.equal(await o.read("a.txt"), "top-a");
  assert.equal(await base.read("a.txt"), "base-a", "base untouched");
  await o.append("bits/x/events.jsonl", "line2\n");
  assert.equal(await top.read("bits/x/events.jsonl"), "line1\nline2\n", "copied up then appended");
  await o.append("bits/x/events.jsonl", "line3\n");
  assert.equal(await o.read("bits/x/events.jsonl"), "line1\nline2\nline3\n");
  assert.equal(await o.read("missing"), undefined);
  assert.deepEqual(o.topPaths, ["a.txt", "bits/x/events.jsonl"]);
});

test("list is the union of base and top", async () => {
  const base = new MemoryStore();
  const top = new MemoryStore();
  await base.write("bits/a/passport.json", "{}");
  const o = OverlayStore.fresh(base, top);
  await o.write("bits/b/passport.json", "{}");
  assert.deepEqual(await o.list("bits"), ["a", "b"]);
  assert.deepEqual(await o.list(""), ["bits"]);
});

test("open() indexes an existing top so reads prefer it without asking again", async () => {
  const base = new MemoryStore();
  const top = new MemoryStore();
  await base.write("bits/a/passport.json", "base");
  await top.write("bits/a/passport.json", "top");
  await top.write("manifest.json", "{}");
  const o = await OverlayStore.open(base, top);
  assert.equal(await o.read("bits/a/passport.json"), "top");
  assert.equal(await o.read("manifest.json"), "{}");
  assert.deepEqual(o.topPaths, ["bits/a/passport.json", "manifest.json"]);
});

test("a packed base plus a delta top is one scene: resume, edit, reopen, digest holds", async () => {
  const folder = new MemoryStore();
  const live = await seed(folder);
  const packText = packToText(await packScene(folder));
  const base = PackedStore.fromText(packText);
  const top = new MemoryStore();
  const overlay = OverlayStore.fresh(base, top);

  // Nothing written yet: the overlay opens to the same scene as the folder.
  assert.equal(await sceneDigest(await openScene(overlay)), await sceneDigest(live));

  // Continue the scene through the overlay: edits land only in the top.
  const sink = await SceneSink.resume(overlay);
  const g = await openScene(overlay, { attach: sink });
  g.remove(g.at(1, 1, 1)!);
  g.at(0, 0, 0)!.setPassport({ delta: true });
  await sink.flush();
  const touched = overlay.topPaths;
  assert.ok(touched.includes("manifest.json"));
  assert.ok(touched.some((p) => p.endsWith("/passport.json")));
  assert.ok(touched.length < 12, `only changed bits reach the top: ${touched.length} paths`);
  assert.equal(
    await top.read(ledgerPath(live.at(2, 2, 2)!.id)),
    undefined,
    "untouched bits stay in the base",
  );

  // Reopen from base + indexed top, as a reload would.
  const reopened = await openScene(await OverlayStore.open(base, top));
  assert.equal(await sceneDigest(reopened), await sceneDigest(g));
  assert.equal(reopened.size, 26);
  assert.deepEqual(reopened.get(live.at(0, 0, 0)!.id)!.passport, { delta: true });
  assert.ok((await top.read(passportPath(live.at(0, 0, 0)!.id)))!.includes('"delta":true'));
});
