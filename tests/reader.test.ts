/**
 * The reader's embedding (PLAN-4.md Phase 17): JSON that survives a
 * <script> element, the tamper used by the oracle, and the built-in
 * signed scene the oracle opens.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { builtinSigned, embedReader, scriptJson, tamper } from "../scripts/reader-scene.ts";
import { PackedStore } from "../src/pack.ts";
import { verifyScene } from "../src/verify.ts";

test("scriptJson leaves no `<` and parses back to the same value, including a closing script tag in a string", () => {
  const value = { name: "</script><b>x</b>", sep: "a b c", n: 1 };
  const text = scriptJson(value);
  assert.ok(!text.includes("<"));
  assert.ok(!text.includes(" "));
  assert.deepEqual(JSON.parse(text), value);
});

test("embedReader injects at the marker, or before </head> when the marker is gone, and the blocks parse", async () => {
  const { pack, didDoc } = await builtinSigned();
  const spec = "# SPEC\n\nSome text with </script> in it.\n";
  for (const template of [
    "<html><head><!--vpb:embed--></head><body></body></html>",
    "<html><head><title>x</title></head><body></body></html>",
  ]) {
    const html = embedReader(template, { pack, spec, didDoc, plain: true });
    assert.ok(html.indexOf('id="vpb-pack"') < html.indexOf("</head>"));
    const block = (id: string) =>
      /<script type="application\/json" id="ID">([\s\S]*?)<\/script>/.source.replace("ID", id);
    const packText = new RegExp(block("vpb-pack")).exec(html)![1]!;
    assert.equal(JSON.parse(packText).manifest.scene, pack.manifest.scene);
    const specText = new RegExp(block("vpb-spec")).exec(html)![1]!;
    assert.equal(JSON.parse(specText).text, spec);
    const didText = new RegExp(block("vpb-did")).exec(html)![1]!;
    assert.equal(JSON.parse(didText).id, didDoc.id);
    assert.equal((html.match(/<\/script>/g) ?? []).length, 3, "no stray closing tags");
  }
  assert.throws(() => embedReader("<html></html>", { pack }), /no <\/head>/);
  const gz = embedReader("<html><head></head></html>", { pack });
  const b64 = /id="vpb-pack-gz">([^<]*)<\/script>/.exec(gz)![1]!;
  const inflated = gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
  assert.equal(
    inflated,
    `${JSON.stringify(pack)}
`,
  );
  assert.ok(gz.length < JSON.stringify(pack).length / 4, "gzip shrinks the pack at least fourfold");
});

test("the built-in scene is signed and verifies against its own document; the tamper names one bit and fails the seal", async () => {
  const { pack, didDoc } = await builtinSigned();
  const good = await verifyScene(new PackedStore(pack), { resolve: async () => didDoc });
  assert.equal(good.ok, true);
  assert.equal(good.signature, "verified");
  assert.equal(good.did, didDoc.id);
  const before = JSON.stringify(pack);
  const bit = tamper(pack);
  const after = JSON.stringify(pack);
  assert.equal(before.length, after.length, "one character changed, none added");
  let diff = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diff++;
  assert.equal(diff, 1);
  const bad = await verifyScene(new PackedStore(pack), { resolve: async () => didDoc });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatches, [{ id: bit, file: "events" }]);
  assert.equal(
    bad.signature,
    "verified",
    "the signature still matches the manifest; the ledger is what changed",
  );
});
