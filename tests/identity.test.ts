import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertionKeys,
  bitDid,
  buildDidDocument,
  didWebUrl,
  frameDid,
  resolveDidWeb,
} from "../src/did.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import {
  fromBase64Url,
  generateKeyPair,
  keyId,
  publicOf,
  signText,
  toBase64Url,
  verifyText,
} from "../src/keys.ts";
import { PackedStore, packScene } from "../src/pack.ts";
import { ledgerPath, readManifest, SceneSink } from "../src/scene.ts";
import { MemoryStore } from "../src/store.ts";
import { sealScene, sealText, verifyScene } from "../src/verify.ts";

test("keys: sign and verify round-trip, the wrong key and the wrong text fail, base64url is exact", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const sig = await signText(a.privateKey, "hello");
  assert.equal(fromBase64Url(sig).length, 64);
  assert.ok(await verifyText(a.publicKey, "hello", sig));
  assert.ok(
    await verifyText(publicOf(a.privateKey), "hello", sig),
    "the public half of a private JWK verifies",
  );
  assert.equal(await verifyText(b.publicKey, "hello", sig), false);
  assert.equal(await verifyText(a.publicKey, "hellO", sig), false);
  assert.equal(await verifyText(a.publicKey, "hello", "not-a-signature"), false);
  assert.equal(await verifyText(a.publicKey, "hello", `${sig.slice(0, -2)}AA`), false);
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual([...fromBase64Url(toBase64Url(bytes))], [...bytes]);
  assert.ok(!toBase64Url(bytes).includes("="), "no padding");
  assert.match(await keyId(a.publicKey), /^[0-9a-f]{16}$/);
  assert.ok(!("d" in publicOf(a.privateKey)), "publicOf drops the private scalar");
});

test("did:web: names and URLs follow the method specification; a bit's DID is a path under its container", async () => {
  const did = frameDid("skinnerboxentertainment.github.io", "VoxelPixelThingie/ns", "01a0-frame");
  assert.equal(
    did,
    "did:web:skinnerboxentertainment.github.io:VoxelPixelThingie:ns:frame:01a0-frame",
  );
  assert.equal(
    didWebUrl(did),
    "https://skinnerboxentertainment.github.io/VoxelPixelThingie/ns/frame/01a0-frame/did.json",
  );
  assert.equal(didWebUrl("did:web:example.org"), "https://example.org/.well-known/did.json");
  assert.equal(
    didWebUrl("did:web:example.org:user:alice"),
    "https://example.org/user/alice/did.json",
  );
  assert.equal(didWebUrl("did:web:localhost%3A3000:x"), "https://localhost:3000/x/did.json");
  assert.throws(() => didWebUrl("did:key:z6Mk"), /not a did:web/);
  assert.equal(bitDid(did, "abc"), `${did}/bit/abc`);

  const { publicKey } = await generateKeyPair();
  const doc = await buildDidDocument(did, publicKey, {
    services: {
      manifest: "https://example.org/scene/manifest.json",
      passport: "https://example.org/passport/",
    },
  });
  assert.equal(doc.id, did);
  assert.equal(doc.verificationMethod.length, 1);
  assert.equal(doc.verificationMethod[0]!.type, "JsonWebKey2020");
  assert.equal(doc.verificationMethod[0]!.publicKeyJwk.x, publicKey.x);
  assert.deepEqual(doc.assertionMethod, [doc.verificationMethod[0]!.id]);
  assert.equal(doc.service?.length, 2);
  assert.deepEqual(
    assertionKeys(doc).map((k) => k.x),
    [publicKey.x],
  );

  // Resolution fetches the method URL and refuses a document for another DID.
  const fetched: string[] = [];
  const fetchFn = async (url: string) => {
    fetched.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(doc) };
  };
  const resolved = await resolveDidWeb(did, fetchFn);
  assert.equal(resolved.id, did);
  assert.deepEqual(fetched, [didWebUrl(did)]);
  await assert.rejects(
    resolveDidWeb("did:web:example.org:other", fetchFn),
    /is for did:web:skinner/,
  );
  await assert.rejects(
    resolveDidWeb(did, async () => ({ ok: false, status: 404, text: async () => "" })),
    /404/,
  );
});

async function smallScene() {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  const g = FlatGrid.fill(2, 2, 1, { emission: { color: 0x1f6feb, light: 0.6 }, sink });
  g.setPresent(g.at(0, 0, 0)!, false);
  await sink.flush();
  return { mem, g };
}

test("a signed seal verifies through the DID document; rewriting the manifest is forged; a tampered ledger names the bit; unsigned still stands", async () => {
  const { mem, g } = await smallScene();
  const { publicKey, privateKey } = await generateKeyPair();
  const did = frameDid("example.org", "scenes", g.id);
  const doc = await buildDidDocument(did, publicKey);
  const resolve = async (d: string) => {
    if (d !== did) throw new Error("unknown DID");
    return doc;
  };

  // Unsigned first: a seal with no signature verifies and says so.
  await sealScene(mem);
  let report = await verifyScene(mem, { resolve });
  assert.equal(report.ok, true);
  assert.equal(report.signature, "unsigned");
  assert.equal(report.checked, 4);

  // Signed: verified with the resolver, unresolved without one, and the pack carries it.
  await sealScene(mem, { did, privateKey });
  const manifest = (await readManifest(mem))!;
  assert.equal(manifest.signature?.did, did);
  assert.equal(manifest.signature?.alg, "EdDSA");
  assert.equal(manifest.signature?.keyId, await keyId(publicKey));
  report = await verifyScene(mem, { resolve });
  assert.equal(report.ok, true);
  assert.equal(report.signature, "verified");
  assert.equal(report.did, did);
  assert.equal((await verifyScene(mem)).signature, "unresolved");
  assert.equal((await verifyScene(mem)).ok, true, "unresolved is not a failure");
  const packed = new PackedStore(await packScene(mem));
  assert.equal((await verifyScene(packed, { resolve })).signature, "verified");

  // The signature covers the hashes: rewrite one hash and re-hash the file to match, and it is forged.
  const forgedStore = new MemoryStore();
  const pack = await packScene(mem);
  const victim = Object.keys(pack.bits)[0]!;
  const forgedLedger = `${pack.bits[victim]!.events}${JSON.stringify({ forged: true })}\n`;
  const forgedManifest = { ...pack.manifest, hashes: { ...pack.manifest.hashes! } };
  const { sha256Hex } = await import("../src/verify.ts");
  forgedManifest.hashes[victim] = {
    ...forgedManifest.hashes[victim]!,
    events: await sha256Hex(forgedLedger),
  };
  await forgedStore.write("manifest.json", JSON.stringify(forgedManifest));
  for (const [id, b] of Object.entries(pack.bits)) {
    await forgedStore.write(`bits/${id}/passport.json`, b.passport ?? "");
    await forgedStore.write(ledgerPath(id), id === victim ? forgedLedger : (b.events ?? ""));
  }
  report = await verifyScene(forgedStore, { resolve });
  assert.equal(report.mismatches.length, 0, "the forger kept the per-file hashes consistent");
  assert.equal(report.signature, "forged");
  assert.equal(report.ok, false);
  assert.match(report.reason!, /signature does not match/);

  // A tampered ledger without touching the manifest fails the hash and names the bit.
  const tampered = new PackedStore(await packScene(mem));
  const original = tampered.pack.bits[victim]!.events ?? "";
  tampered.pack.bits[victim]!.events = original.replace("0", "1");
  assert.notEqual(tampered.pack.bits[victim]!.events, original);
  report = await verifyScene(tampered, { resolve });
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches, [{ id: victim, file: "events" }]);
  assert.equal(report.signature, "verified", "the manifest itself is intact");

  // A resolver that fails leaves the signature unresolved, and the hashes still decide.
  report = await verifyScene(mem, {
    resolve: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(report.signature, "unresolved");
  assert.equal(report.ok, true);

  // A different key's document makes the same seal forged.
  const other = await generateKeyPair();
  const otherDoc = await buildDidDocument(did, other.publicKey);
  report = await verifyScene(mem, { resolve: async () => otherDoc });
  assert.equal(report.signature, "forged");

  // sealText is stable regardless of id order.
  const ids = manifest.ids!;
  assert.equal(
    sealText(g.id, [...ids].reverse(), manifest.hashes!),
    sealText(g.id, ids, manifest.hashes!),
  );
});
