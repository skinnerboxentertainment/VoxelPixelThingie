/**
 * Witnessed seals and key rotation (PLAN-4.md Phase 18, ADR 0013): the
 * notary reference, two recorded RFC 3161 tokens verified offline, the
 * request builder byte-equal to openssl's, and the chain walk with a
 * retired key.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromHex, hex, parseDer } from "../src/der.ts";
import {
  buildDidDocument,
  frameDid,
  type RotationStatement,
  rotateKey,
  rotationPath,
} from "../src/did.ts";
import { FlatGrid } from "../src/flat-grid.ts";
import { generateKeyPair, keyId } from "../src/keys.ts";
import { PackedStore, packScene } from "../src/pack.ts";
import {
  buildTimeStampReq,
  parseTimeStampReq,
  parseTimeStampResp,
  requestTimeStamp,
  verifyTimeStampToken,
} from "../src/rfc3161.ts";
import { readManifest, SceneSink } from "../src/scene.ts";
import { MemoryStore } from "../src/store.ts";
import { sealScene, verifyScene, witnessedDigest } from "../src/verify.ts";
import { NotaryWitness, Rfc3161Witness, verifyWitness, type WitnessProof } from "../src/witness.ts";

const FIXTURES = new URL("./fixtures/rfc3161/", import.meta.url);
const FIXTURE_DIGEST = "d7d877c6eabe3e1d27fd3d7429dccde3fbf5e1d52ed49d88715a5a3f2e1b7313";
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));

async function scene() {
  const mem = new MemoryStore();
  const sink = new SceneSink(mem);
  const g = FlatGrid.fill(2, 2, 1, { emission: { color: 0x1f6feb, light: 0.6 }, sink });
  await sink.flush();
  return { mem, g };
}

test("notary: a proof holds for its digest, is anchored only when trusted, and fails for another digest, a tampered proof, or a mismatched key", async () => {
  const notary = await generateKeyPair();
  const w = new NotaryWitness(notary.privateKey, { clock: () => 1_800_000_000_000 });
  const proof = await w.attest("ab".repeat(32));
  assert.equal(proof.kind, "vpb-notary/1");
  assert.equal(proof.witness, `notary:${await keyId(notary.publicKey)}`);
  assert.equal(proof.time, 1_800_000_000_000);
  const plain = await verifyWitness(proof, "ab".repeat(32));
  assert.equal(plain.ok, true);
  assert.equal(plain.anchored, false);
  const trusted = await verifyWitness(proof, "ab".repeat(32), { notaries: [notary.publicKey] });
  assert.equal(trusted.anchored, true);
  assert.equal((await verifyWitness(proof, "cd".repeat(32))).ok, false);
  const other = await generateKeyPair();
  const swapped: WitnessProof = { ...proof, key: other.publicKey };
  assert.match(
    (await verifyWitness(swapped, "ab".repeat(32))).reason!,
    /does not match the witness id/,
  );
  const lied: WitnessProof = { ...proof, time: proof.time + 1 };
  assert.match((await verifyWitness(lied, "ab".repeat(32))).reason!, /does not verify/);
});

test("a witnessed seal: the report names the witness and the time with the DID unresolvable; a proof over another digest does not count", async () => {
  const { mem, g } = await scene();
  const container = await generateKeyPair();
  const notary = await generateKeyPair();
  const did = frameDid("gone.example.invalid", "", g.id);
  const at = 1_700_000_000_000;
  await sealScene(
    mem,
    { did, privateKey: container.privateKey },
    { witnesses: [new NotaryWitness(notary.privateKey, { clock: () => at })] },
  );
  const manifest = (await readManifest(mem))!;
  assert.equal(manifest.signature?.witness?.length, 1);
  assert.equal(manifest.signature!.witness![0]!.digest, await witnessedDigest(manifest.signature!));

  // No resolver: unresolved, but witnessed, and the hashes hold.
  const offline = await verifyScene(mem, { trust: { notaries: [notary.publicKey] } });
  assert.equal(offline.ok, true);
  assert.equal(offline.signature, "unresolved");
  assert.equal(offline.witnesses?.length, 1);
  assert.equal(offline.witnesses![0]!.ok, true);
  assert.equal(offline.witnesses![0]!.anchored, true);
  assert.equal(offline.witnesses![0]!.witness, `notary:${await keyId(notary.publicKey)}`);
  assert.equal(offline.witnessedAt, at);

  // A resolver that fails is the same as none.
  const dead = await verifyScene(mem, {
    resolve: async () => {
      throw new Error("host gone");
    },
  });
  assert.equal(dead.signature, "unresolved");
  assert.equal(dead.witnessedAt, at);

  // The proof travels in the pack.
  const packed = new PackedStore(await packScene(mem));
  assert.equal((await verifyScene(packed)).witnessedAt, at);

  // A proof moved onto another seal does not count.
  const { mem: mem2 } = await scene();
  await sealScene(mem2, { did, privateKey: container.privateKey });
  const m2 = (await readManifest(mem2))!;
  m2.signature!.witness = manifest.signature!.witness;
  await mem2.write("manifest.json", JSON.stringify(m2));
  const moved = await verifyScene(mem2);
  assert.equal(moved.witnesses![0]!.ok, false);
  assert.match(moved.witnesses![0]!.reason!, /different digest/);
  assert.equal(moved.witnessedAt, undefined);

  await assert.rejects(
    sealScene(mem, undefined, { witnesses: [new NotaryWitness(notary.privateKey)] }),
    /seal with a signer/,
  );
});

test("rfc 3161: both recorded tokens verify offline, one ECDSA and one RSA; a flipped byte and a wrong digest fail; the request builder matches openssl byte for byte", async () => {
  for (const [name, algorithm] of [
    ["freetsa.tsr", /^ECDSA P-384 with SHA-512$/],
    ["digicert.tsr", /^RSA PKCS#1 v1.5 with SHA-256$/],
  ] as const) {
    const resp = parseTimeStampResp(fixture(name));
    assert.equal(resp.status, 0, `${name} granted`);
    const v = await verifyTimeStampToken(resp.token!, FIXTURE_DIGEST);
    assert.equal(v.ok, true, `${name}: ${v.reason}`);
    assert.equal(new Date(v.time!).toISOString(), "2026-09-06T21:33:18.000Z");
    assert.equal(v.imprint, FIXTURE_DIGEST);
    assert.equal(v.nonce, "4bc1f166a49400fb");
    assert.match(v.signer!.algorithm, algorithm);
    assert.match(v.signer!.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(v.signer!.subject.includes("CN="), v.signer!.subject);
    const wrong = await verifyTimeStampToken(resp.token!, "00".repeat(32));
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason!, /imprint does not match/);
    // Flip a byte inside the signature value (the last octet string of the token).
    const flipped = new Uint8Array(resp.token!);
    flipped[flipped.length - 5] ^= 0x01;
    const bad = await verifyTimeStampToken(flipped, FIXTURE_DIGEST);
    assert.equal(bad.ok, false);
    assert.match(bad.reason!, /signature does not verify|messageDigest|malformed/);
    // The proof form goes through the witness verifier and is unanchored without a fingerprint list.
    const proof: WitnessProof = {
      kind: "rfc3161/1",
      witness: name,
      digest: FIXTURE_DIGEST,
      proof: Buffer.from(resp.token!).toString("base64"),
      time: v.time!,
    };
    const verdict = await verifyWitness(proof, FIXTURE_DIGEST);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.anchored, false);
    const anchored = await verifyWitness(proof, FIXTURE_DIGEST, {
      tsaFingerprints: [v.signer!.fingerprint],
    });
    assert.equal(anchored.anchored, true);
    assert.equal(
      (await verifyWitness({ ...proof, time: v.time! + 1000 }, FIXTURE_DIGEST)).ok,
      false,
    );
  }
  const req = fixture("req.tsq");
  const parsed = parseTimeStampReq(req);
  assert.equal(parsed.imprint, FIXTURE_DIGEST);
  assert.equal(parsed.certReq, true);
  const mine = buildTimeStampReq(FIXTURE_DIGEST, { nonce: fromHex(parsed.nonce!), certReq: true });
  assert.equal(hex(mine), hex(req), "byte-equal to openssl ts -query");
  assert.equal(parseDer(mine).children.length, 4);
});

test("rfc 3161 live: a public authority attests a fresh digest through the witness contract, when reachable", async (t) => {
  const url = "http://timestamp.digicert.com";
  const digest = "11".repeat(32);
  let token: Uint8Array;
  try {
    token = await requestTimeStamp(url, digest, { timeoutMs: 8000 });
  } catch (err) {
    t.skip(`the authority was not reachable: ${(err as Error).message}`);
    return;
  }
  const v = await verifyTimeStampToken(token, digest);
  assert.equal(v.ok, true, v.reason ?? "");
  assert.ok(Math.abs(v.time! - Date.now()) < 10 * 60_000, "genTime within ten minutes of now");
  const proof = await new Rfc3161Witness(url, { timeoutMs: 8000 }).attest(digest);
  assert.equal((await verifyWitness(proof, digest)).ok, true);
});

test("rotation: an old seal verifies through the chain; a broken link is forged; a seal witnessed after retirement is retired", async () => {
  const { mem, g } = await scene();
  const k1 = await generateKeyPair();
  const k2 = await generateKeyPair();
  const k3 = await generateKeyPair();
  const notary = await generateKeyPair();
  const did = frameDid("example.org", "scenes", g.id);
  const before = 1_700_000_000_000;
  const retiredAt = 1_700_000_100_000;
  const after = 1_700_000_200_000;

  // Sealed and witnessed with k1 before its retirement.
  await sealScene(
    mem,
    { did, privateKey: k1.privateKey },
    { witnesses: [new NotaryWitness(notary.privateKey, { clock: () => before })] },
  );
  const r12 = await rotateKey(k1.privateKey, k2.publicKey, retiredAt);
  const r23 = await rotateKey(k2.privateKey, k3.publicKey, retiredAt + 1);
  const doc = { ...(await buildDidDocument(did, k3.publicKey)), rotations: [r12, r23] };
  const path = await rotationPath(doc, await keyId(k1.publicKey));
  assert.equal(path.ok, true);
  assert.deepEqual(path.via, [
    await keyId(k1.publicKey),
    await keyId(k2.publicKey),
    await keyId(k3.publicKey),
  ]);
  assert.equal(path.retired, retiredAt);
  const resolve = async () => doc;
  const good = await verifyScene(mem, { resolve });
  assert.equal(good.signature, "verified");
  assert.equal(good.ok, true);
  assert.deepEqual(good.rotation?.via, path.via);
  assert.equal(good.rotation?.retired, retiredAt);

  // The same seal witnessed only after retirement is retired, and not ok.
  const late = new MemoryStore();
  const pack = await packScene(mem);
  const m = pack.manifest;
  const lateProof = await new NotaryWitness(notary.privateKey, { clock: () => after }).attest(
    await witnessedDigest(m.signature!),
  );
  await late.write(
    "manifest.json",
    JSON.stringify({ ...m, signature: { ...m.signature, witness: [lateProof] } }),
  );
  for (const [id, b] of Object.entries(pack.bits)) {
    await late.write(`bits/${id}/passport.json`, b.passport ?? "");
    await late.write(`bits/${id}/events.jsonl`, b.events ?? "");
  }
  const retired = await verifyScene(late, { resolve });
  assert.equal(retired.signature, "retired");
  assert.equal(retired.ok, false);
  assert.match(retired.reason!, /after it was retired/);

  // Unwitnessed: verified through the chain, time unknown.
  await late.write(
    "manifest.json",
    JSON.stringify({ ...m, signature: { ...m.signature, witness: undefined } }),
  );
  const unwitnessed = await verifyScene(late, { resolve });
  assert.equal(unwitnessed.signature, "verified");
  assert.equal(unwitnessed.witnessedAt, undefined);

  // A broken link: the second statement signed by the wrong key.
  const forgedLink: RotationStatement = { ...r23, signature: r12.signature };
  const brokenDoc = { ...doc, rotations: [r12, forgedLink] };
  assert.equal((await rotationPath(brokenDoc, await keyId(k1.publicKey))).ok, false);
  assert.equal((await verifyScene(mem, { resolve: async () => brokenDoc })).signature, "forged");

  // A chain that never reaches a current key.
  const orphanDoc = { ...(await buildDidDocument(did, k3.publicKey)), rotations: [r12] };
  const orphan = await rotationPath(orphanDoc, await keyId(k1.publicKey));
  assert.equal(orphan.ok, false);
  assert.match(orphan.reason!, /no rotation from/);
});
