import assert from "node:assert/strict";
import { test } from "node:test";
import { Grid } from "../src/grid.ts";
import { ledgerPath, openScene, passportPath, readManifest, SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
import { FetchStore } from "../src/store-fetch.ts";
import { sceneDigest, sealScene, sha256Hex, verifyScene } from "../src/verify.ts";

/** A fetch that serves a MemoryStore over a fake URL prefix, like a static host would. */
function fetchFor(store: MemoryStore, base = "https://example.test/scene/") {
  return async (url: string) => {
    if (!url.startsWith(base)) return { ok: false, status: 404, text: async () => "" };
    const text = store.files.get(url.slice(base.length));
    return text === undefined
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => text };
  };
}

async function seed(store: MemoryStore): Promise<Grid> {
  const sink = new SceneSink(store);
  const g = Grid.fill(3, 3, 3, { emission: { color: 0x1f6feb }, sink });
  for (const b of g.bits()) b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
  g.remove(g.at(2, 2, 2)!);
  g.at(0, 0, 0)!.setPassport({ name: "origin" });
  await sink.flush();
  return g;
}

test("sha256Hex matches a known vector", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("a scene opened over a URL equals the local scene: same digest", async () => {
  const store = new MemoryStore();
  const live = await seed(store);
  await sealScene(store);
  const remote = new FetchStore("https://example.test/scene", fetchFor(store));
  const viaUrl = await openScene(remote);
  const local = await openScene(store);
  const [a, b, c] = await Promise.all([sceneDigest(live), sceneDigest(local), sceneDigest(viaUrl)]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(viaUrl.size, 26);
  assert.deepEqual(viaUrl.get(live.at(0, 0, 0)!.id)!.passport, { name: "origin" });
});

test("FetchStore is read-only and lists bits from manifest.ids", async () => {
  const store = new MemoryStore();
  await seed(store);
  const remote = new FetchStore("https://example.test/scene/", fetchFor(store));
  assert.equal((await remote.list("bits")).length, 27);
  await assert.rejects(remote.write("x", "y"), /read-only/);
  await assert.rejects(remote.append("x", "y"), /read-only/);
  await assert.rejects(remote.list("other"), /only list bits/);
  assert.equal(await remote.read("nope.json"), undefined);
  const noIds = new MemoryStore();
  noIds.files.set("manifest.json", JSON.stringify({ format: "vpb-scene/1", scene: "s", seq: 0 }));
  await assert.rejects(
    new FetchStore("https://example.test/scene/", fetchFor(noIds)).list("bits"),
    /no ids/,
  );
});

test("seal and verify: a tampered ledger and a tampered passport are both caught", async () => {
  const store = new MemoryStore();
  const live = await seed(store);
  assert.equal((await verifyScene(store)).reason, "scene is not sealed");
  const n = await sealScene(store);
  assert.equal(n, 27);
  const clean = await verifyScene(store);
  assert.equal(clean.ok, true);
  assert.equal(clean.checked, 27);

  const victim = live.at(1, 1, 1)!.id;
  store.files.set(
    ledgerPath(victim),
    `${store.files.get(ledgerPath(victim))}{"type":"annotated"}\n`,
  );
  const other = live.at(0, 1, 0)!.id;
  const tampered = store.files
    .get(passportPath(other))!
    .replace('"present":true', '"present":false');
  assert.notEqual(tampered, store.files.get(passportPath(other)), "the tamper changed the file");
  store.files.set(passportPath(other), tampered);
  const dirty = await verifyScene(store);
  assert.equal(dirty.ok, false);
  assert.deepEqual(
    dirty.mismatches,
    [
      { id: victim, file: "events" },
      { id: other, file: "passport" },
    ].sort((a, b) => (a.id + a.file < b.id + b.file ? -1 : 1)),
  );
});

test("writing after sealing drops the stale hashes", async () => {
  const store = new MemoryStore();
  await seed(store);
  await sealScene(store);
  const sink = await SceneSink.resume(store);
  const g = await openScene(store, { attach: sink });
  g.at(0, 0, 1)!.annotate("k", 1);
  await sink.flush();
  assert.equal((await readManifest(store))!.hashes, undefined);
  assert.equal((await verifyScene(store)).reason, "scene is not sealed");
});
