import assert from "node:assert/strict";
import { test } from "node:test";
import { Grid } from "../src/grid.ts";

const gridFactory = (o?: ConstructorParameters<typeof Grid>[0]) => new Grid(o);

import {
  PACK_FORMAT,
  PackedStore,
  packFromText,
  packScene,
  packToText,
  unpackScene,
} from "../src/pack.ts";
import { openScene, SceneSink } from "../src/scene.ts";
import { EDGE_SLOTS } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
import { sceneDigest, sealScene, verifyScene } from "../src/verify.ts";

async function seed(store: MemoryStore): Promise<Grid> {
  const sink = new SceneSink(store);
  const g = Grid.fill(3, 3, 3, { emission: { color: 0x1f6feb }, sink });
  for (const b of g.bits()) b.emitAll(EDGE_SLOTS, { color: 0x58a6ff, light: 1 });
  g.remove(g.at(2, 2, 2)!);
  g.at(0, 0, 0)!.setPassport({ name: "origin" });
  await sink.flush();
  await sealScene(store);
  return g;
}

test("a sealed scene packs to one file, verifies, and opens to the same digest", async () => {
  const store = new MemoryStore();
  const live = await seed(store);
  const pack = await packScene(store);
  assert.equal(pack.format, PACK_FORMAT);
  assert.equal(Object.keys(pack.bits).length, 27);
  const text = packToText(pack);
  const packed = PackedStore.fromText(text);
  const v = await verifyScene(packed);
  assert.equal(v.ok, true, "hashes verify against the packed texts byte for byte");
  assert.equal(v.checked, 27);
  const opened = await openScene(packed, { factory: gridFactory });
  assert.equal(await sceneDigest(opened), await sceneDigest(live));
  assert.deepEqual(opened.get(live.at(0, 0, 0)!.id)!.passport, { name: "origin" });
});

test("unpack reproduces the folder layout and the same digest", async () => {
  const store = new MemoryStore();
  const live = await seed(store);
  const pack = await packScene(store);
  const folder = new MemoryStore();
  assert.equal(await unpackScene(pack, folder), 27);
  assert.deepEqual([...folder.files.keys()].sort(), [...store.files.keys()].sort());
  assert.equal((await verifyScene(folder)).ok, true);
  assert.equal(
    await sceneDigest(await openScene(folder, { factory: gridFactory })),
    await sceneDigest(live),
  );
});

test("PackedStore is read-only, lists bits, and can be fetched from a URL", async () => {
  const store = new MemoryStore();
  await seed(store);
  const text = packToText(await packScene(store));
  const fetchFn = async (url: string) =>
    url === "https://gateway.test/ipfs/cid/scene.json"
      ? { ok: true, status: 200, text: async () => text }
      : { ok: false, status: 404, text: async () => "" };
  const packed = await PackedStore.fromUrl("https://gateway.test/ipfs/cid/scene.json", fetchFn);
  assert.equal((await packed.list("bits")).length, 27);
  assert.deepEqual(await packed.list(""), ["bits", "manifest.json"]);
  assert.equal(await packed.read("bits/nope/passport.json"), undefined);
  assert.equal(await packed.read("unrelated.txt"), undefined);
  await assert.rejects(packed.write("a", "b"), /read-only/);
  await assert.rejects(packed.append("a", "b"), /read-only/);
  await assert.rejects(PackedStore.fromUrl("https://gateway.test/other", fetchFn), /404/);
});

test("packFromText rejects the wrong format", () => {
  assert.throws(() => packFromText(JSON.stringify({ format: "vpb-scene/1" })), /not a scene pack/);
  assert.throws(() => packFromText(JSON.stringify({ format: PACK_FORMAT })), /malformed/);
});
