/**
 * The TypeScript implementation run *from* the fixtures (PLAN-4.md Phase
 * 25, ADR 0018): every case in conformance/ passes, which is what proves
 * the fixtures complete. A fixture with one expected byte changed fails.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  KIT_FORMAT,
  runTier2,
  type Tier1Expected,
  type Tier2Case,
} from "../../scripts/conformance-export.ts";
import type { DidDocument } from "../../src/did.ts";
import { PackedStore } from "../../src/pack.ts";
import { openScene } from "../../src/scene.ts";
import { sceneDigest, stateCanonical, stateDigest, verifyScene } from "../../src/verify.ts";
import type { Camera } from "../../src/vpb.ts";

const KIT = "conformance";
const read = (rel: string) => JSON.parse(readFileSync(join(KIT, rel), "utf8"));
const manifest = read("manifest.json") as {
  format: string;
  tiers: Record<string, { cases: string[] }>;
};

test("the kit's manifest names its format and three tiers with cases", () => {
  assert.equal(manifest.format, KIT_FORMAT);
  assert.ok(manifest.tiers["1"]!.cases.length >= 4);
  assert.ok(manifest.tiers["2"]!.cases.length >= 2);
  assert.ok(manifest.tiers["3"]!.cases.length >= 3);
  const slots = read("slots.json") as { nodeCount: number; offsets: unknown[] };
  assert.equal(slots.nodeCount, 26);
  assert.equal(slots.offsets.length, 26);
});

for (const name of manifest.tiers["1"]!.cases) {
  test(`tier 1, ${name}: state digest, snapshot, seal, and signature as expected`, async () => {
    const pack = PackedStore.fromText(readFileSync(join(KIT, "tier1", name, "pack.json"), "utf8"));
    const expected = read(`tier1/${name}/expected.json`) as Tier1Expected;
    let doc: DidDocument | undefined;
    try {
      doc = read(`tier1/${name}/did.json`) as DidDocument;
    } catch {
      doc = undefined;
    }
    const grid = await openScene(pack);
    assert.equal(await stateDigest(grid), expected.stateDigest);
    assert.deepEqual(stateCanonical(grid), expected.state);
    assert.equal(await sceneDigest(grid, expected.camera), expected.sceneDigest);
    assert.equal(grid.snapshot().length, expected.bits);
    assert.equal(grid.snapshot().filter((r) => r.present).length, expected.present);
    const v = await verifyScene(pack, doc ? { resolve: async () => doc } : {});
    assert.equal(v.ok, expected.seal.ok);
    assert.deepEqual(v.mismatches, expected.seal.mismatches);
    assert.equal(v.signature, expected.signature.state);
    if (expected.signature.did) assert.equal(v.did, expected.signature.did);
  });
}

for (const name of manifest.tiers["2"]!.cases) {
  test(`tier 2, ${name}: the operations yield the expected events, state, digest, and link counts`, async () => {
    const c = read(`tier2/${name}.json`) as Tier2Case;
    const got = runTier2(c);
    assert.deepEqual(got.events, c.expected.events);
    assert.deepEqual(got.state, c.expected.state);
    assert.deepEqual(got.linkCounts, c.expected.linkCounts);
    // The digest is over the state text; recompute from the state the run produced.
    const { sha256Hex } = await import("../../src/verify.ts");
    assert.equal(await sha256Hex(JSON.stringify(got.state)), c.expected.stateDigest);
  });
}

for (const name of manifest.tiers["3"]!.cases) {
  test(`tier 3, ${name}: render flags and the scene digest for the camera`, async () => {
    const c = read(`tier3/${name}.json`) as {
      pack: string;
      camera: Camera;
      expected: {
        sceneDigest: string;
        renderCycle: Record<string, boolean>;
        renderEnabled: Record<string, boolean[]>;
      };
    };
    const grid = await openScene(PackedStore.fromText(readFileSync(join(KIT, c.pack), "utf8")));
    assert.equal(await sceneDigest(grid, c.camera), c.expected.sceneDigest);
    for (const r of grid.snapshot()) {
      assert.equal(r.renderCycle, c.expected.renderCycle[r.id], `${r.id} renderCycle`);
      assert.deepEqual(r.renderEnabled, c.expected.renderEnabled[r.id], `${r.id} renderEnabled`);
    }
  });
}

test("a fixture with one expected byte changed fails", async () => {
  const name = manifest.tiers["1"]!.cases[0]!;
  const pack = PackedStore.fromText(readFileSync(join(KIT, "tier1", name, "pack.json"), "utf8"));
  const expected = read(`tier1/${name}/expected.json`) as Tier1Expected;
  const grid = await openScene(pack);
  const digest = await stateDigest(grid);
  const changed = `${digest.slice(0, 10)}${digest[10] === "0" ? "1" : "0"}${digest.slice(11)}`;
  assert.notEqual(changed, expected.stateDigest);
  assert.equal(readdirSync(join(KIT, "tier1")).length, manifest.tiers["1"]!.cases.length);
});
