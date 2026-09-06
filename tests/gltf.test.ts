/**
 * glTF interchange (PLAN-4.md Phase 23, ADR 0017): the export validates
 * with the Khronos validator, a round trip keeps the digest with and
 * without the carried ledgers, and an edited translation imports as one
 * `moved` event on that bit only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import validator from "gltf-validator";
import { referenceScene } from "../demo/shared/scene.ts";
import { RecordingSink, TeeSink } from "../src/events.ts";
import {
  EMISSIVE_STRENGTH,
  faceLight,
  fromGltf,
  type GltfJson,
  nodeExtrasOf,
  parseGlb,
  sceneExtrasOf,
  toGlb,
  toGltf,
} from "../src/gltf.ts";
import { SceneSink } from "../src/scene.ts";
import { FACE_SLOTS } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
import { sceneDigest } from "../src/verify.ts";

async function scene() {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  const recorder = new RecordingSink();
  const grid = referenceScene(4, new TeeSink([sink, recorder]));
  const origin = grid.at(0, 0, 0)!;
  grid.wrangle({ actor: "oscar", cause: "label" }, () => {
    origin.setPassport({ name: "origin" });
    origin.emitAll(FACE_SLOTS, { color: 0xff0000, light: 1.5 });
    grid.at(1, 0, 0)!.emit(2, { data: { tag: "seam" } });
    grid.setPresent(grid.at(2, 0, 0)!, false);
  });
  await sink.flush();
  return { mem, sink, recorder, grid };
}

test("the export validates with the Khronos validator, one node per bit, materials deduplicated, emission in the material, identity in extras", async () => {
  const { mem, grid } = await scene();
  const { json, bin } = await toGltf(grid, { store: mem });
  const glb = toGlb(json, bin);
  const report = await validator.validateBytes(glb);
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages.slice(0, 5)));
  const records = grid.snapshot();
  assert.equal(json.nodes.length, records.length);
  assert.equal(json.scenes[0]!.nodes.length, records.length);
  const present = records.filter((r) => r.present).length;
  assert.equal(
    json.nodes.filter((n) => n.mesh !== undefined).length,
    present,
    "absent bits have no mesh",
  );
  assert.equal(
    report.info.totalTriangleCount,
    json.meshes.length * 12,
    "the validator counts a mesh once, however many nodes share it",
  );
  // Materials: the reference face (light 0.6) and the origin's red face over 1; the seam bit's
  // data-only emission changes no color or light, so it shares the reference material.
  assert.equal(json.materials.length, 2, json.materials.map((m) => m.name).join("; "));
  assert.deepEqual(json.extensionsUsed, [EMISSIVE_STRENGTH]);
  const origin = json.nodes.find((n) => nodeExtrasOf(n)?.id === grid.at(0, 0, 0)!.id)!;
  const material = json.materials[json.meshes[origin.mesh!]!.primitives[0]!.material]!;
  assert.deepEqual(
    (material.extensions as Record<string, { emissiveStrength: number }>)[EMISSIVE_STRENGTH],
    { emissiveStrength: faceLight(grid.at(0, 0, 0)!.record()) },
  );
  assert.deepEqual(origin.translation, [0, 0, 0]);
  const extras = nodeExtrasOf(origin)!;
  assert.equal(extras.present, true);
  assert.deepEqual(extras.passport, { name: "origin" });
  assert.equal(extras.emissions.length, 26);
  assert.deepEqual(extras.emissions[0], { color: 0xff0000, light: 1.5 });
  const se = sceneExtrasOf(json)!;
  assert.equal(se.scene, grid.id);
  assert.equal(se.bits, records.length);
  assert.ok(se.pack && se.pack.length > 100, "the pack rides along");
  // A GLB parses back to the same JSON and bytes.
  const parsed = parseGlb(glb);
  assert.deepEqual(parsed.json, JSON.parse(JSON.stringify(json)));
  assert.deepEqual([...parsed.bin!.subarray(0, bin.length)], [...bin]);
  // Without ledgers: no pack, smaller.
  const lean = await toGltf(grid, { ledgers: false });
  assert.equal(sceneExtrasOf(lean.json)!.pack, undefined);
  assert.ok(toGlb(lean.json, lean.bin).length < glb.length);
  await assert.rejects(toGltf(grid), /needs the store/);
});

test("round trip: with the carried ledgers the digest and the history come back; without them the digest still holds and the history is the import's", async () => {
  const { mem, grid } = await scene();
  const digest = await sceneDigest(grid);
  const { json, bin } = await toGltf(grid, { store: mem });
  const back = await fromGltf(parseGlb(toGlb(json, bin)).json);
  assert.equal(back.source, "pack");
  assert.equal(back.moved.length, 0);
  assert.equal(await sceneDigest(back.grid), digest);
  assert.equal(back.grid.id, grid.id);
  const ledger = await back.store.read(`bits/${grid.at(0, 0, 0)!.id}/events.jsonl`);
  assert.ok(ledger?.includes('"cause":"label"'), "the history travelled");

  const lean = await toGltf(grid, { ledgers: false });
  const recorder = new RecordingSink();
  const rebuilt = await fromGltf(lean.json, { sink: recorder });
  assert.equal(rebuilt.source, "nodes");
  assert.equal(await sceneDigest(rebuilt.grid), digest, "state alone reproduces the digest");
  assert.deepEqual(rebuilt.grid.snapshot(), grid.snapshot());
  assert.ok(recorder.events.every((e) => e.actor === "gltf:import"));
  assert.ok(recorder.events.some((e) => e.type === "passport"));
});

test("a node moved in the file imports as exactly one moved event on that bit, under actor gltf:import", async () => {
  const { mem, grid } = await scene();
  const { json } = await toGltf(grid, { store: mem });
  const victim = grid.at(3, 0, 0)!;
  const node = json.nodes.find((n) => nodeExtrasOf(n)?.id === victim.id)!;
  node.translation = [3, 3, 9];
  const edited = JSON.parse(JSON.stringify(json)) as GltfJson;
  const recorder = new RecordingSink();
  const back = await fromGltf(edited, { sink: recorder });
  assert.deepEqual(back.moved, [victim.id]);
  assert.deepEqual(back.grid.get(victim.id)!.position, [3, 3, 9]);
  const fresh = recorder.events.filter((e) => e.actor !== "replay");
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.type, "moved");
  assert.equal(fresh[0]!.actor, "gltf:import");
  assert.equal(fresh[0]!.bit, victim.id);
  assert.notEqual(await sceneDigest(back.grid), await sceneDigest(grid));
});
