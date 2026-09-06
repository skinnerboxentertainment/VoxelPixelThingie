/**
 * Reproducible, attested releases (PLAN-4.md Phase 22, ADR 0016): the
 * manifest is a pure function of the tree, the digest is stable, a
 * signature and witnesses verify, a changed byte names the file, and the
 * SBOM's packages are the lockfile's.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  attestRelease,
  hashTree,
  manifestFor,
  RELEASE_FORMAT,
  type ReleaseManifest,
  releaseText,
  sha256,
  verifyRelease,
} from "../scripts/release.ts";
import { buildDidDocument, frameDid, rotateKey } from "../src/did.ts";
import { generateKeyPair } from "../src/keys.ts";
import { NotaryWitness } from "../src/witness.ts";

async function tree(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "vpb-release-"));
  await fs.mkdir(join(dir, "assets"), { recursive: true });
  await fs.writeFile(join(dir, "index.html"), "<!doctype html><p>hello</p>\n");
  await fs.writeFile(join(dir, "assets", "app.js"), "console.log(1);\n");
  await fs.writeFile(join(dir, "assets", "z.css"), "p{color:red}\n");
  return dir;
}

const meta = { version: "0.3.0", commit: "a".repeat(40), epoch: 1_700_000_000 };

test("the manifest is a pure function of the tree: same bytes, same digest; paths sorted, forward slashes; the digest covers everything but itself", async () => {
  const dir = await tree();
  const a = await manifestFor(meta, { dist: dir });
  const b = await manifestFor(meta, { dist: dir });
  assert.equal(a.format, RELEASE_FORMAT);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.trees.dist!.map((f) => f.path),
    ["assets/app.js", "assets/z.css", "index.html"],
  );
  assert.equal(a.trees.dist![2]!.sha256, sha256("<!doctype html><p>hello</p>\n"));
  const { digest, ...body } = a;
  assert.equal(sha256(releaseText(body)), digest);
  // A different commit or epoch is a different digest; a different key order is not.
  assert.notEqual(
    (await manifestFor({ ...meta, epoch: meta.epoch + 1 }, { dist: dir })).digest,
    digest,
  );
  const shuffled: ReleaseManifest = { ...a, trees: { dist: [...a.trees.dist!].reverse() } };
  const { digest: d2, ...body2 } = shuffled;
  assert.equal(sha256(releaseText(body2)), d2);
  assert.equal((await hashTree(dir)).length, 3);
});

test("verify: the files match, a changed byte names the file, a missing and an extra file are named, and the digest is recomputed", async () => {
  const dir = await tree();
  const manifest = await manifestFor(meta, { dist: dir });
  const good = await verifyRelease(manifest, { trees: { dist: dir } });
  assert.equal(good.ok, true);
  assert.equal(good.digestOk, true);
  assert.equal(good.signature, "none");
  assert.equal(good.provenance, "not checked");
  await fs.writeFile(join(dir, "assets", "app.js"), "console.log(2);\n");
  const changed = await verifyRelease(manifest, { trees: { dist: dir } });
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.mismatches, [
    { tree: "dist", path: "assets/app.js", reason: "changed" },
  ]);
  assert.match(changed.reasons[0]!, /first dist\/assets\/app.js \(changed\)/);
  await fs.rm(join(dir, "assets", "z.css"));
  await fs.writeFile(join(dir, "extra.txt"), "x");
  const more = await verifyRelease(manifest, { trees: { dist: dir } });
  assert.deepEqual(more.mismatches.map((m) => `${m.path}:${m.reason}`).sort(), [
    "assets/app.js:changed",
    "assets/z.css:missing",
    "extra.txt:extra",
  ]);
  const forgedManifest = { ...manifest, version: "9.9.9" };
  const forged = await verifyRelease(forgedManifest, {});
  assert.equal(forged.digestOk, false);
  assert.equal(forged.ok, false);
});

test("attest: the signature verifies through the DID document and through a rotation; a notary witness holds; a wrong key is forged; a moved signature is forged", async () => {
  const dir = await tree();
  const manifest = await manifestFor(meta, { dist: dir });
  const k1 = await generateKeyPair();
  const notary = await generateKeyPair();
  const did = frameDid("example.org", "release", "frame-1");
  const at = 1_700_000_000_000;
  const sig = await attestRelease(manifest, { did, privateKey: k1.privateKey }, [
    new NotaryWitness(notary.privateKey, { clock: () => at }),
  ]);
  assert.equal(sig.digest, manifest.digest);
  assert.equal(sig.witness?.length, 1);
  const doc = await buildDidDocument(did, k1.publicKey);
  const v = await verifyRelease(manifest, {
    trees: { dist: dir },
    signature: sig,
    resolve: async () => doc,
    trust: { notaries: [notary.publicKey] },
  });
  assert.equal(v.ok, true);
  assert.equal(v.signature, "verified");
  assert.equal(v.witnesses![0]!.ok, true);
  assert.equal(v.witnesses![0]!.anchored, true);
  assert.equal(v.witnessedAt, at);
  // Unresolved is not a failure; the files and digest still decide.
  const offline = await verifyRelease(manifest, { signature: sig });
  assert.equal(offline.signature, "unresolved");
  assert.equal(offline.ok, true);
  assert.equal(offline.witnessedAt, at, "witnesses are checked without the DID");
  // Through a rotation.
  const k2 = await generateKeyPair();
  const rotated = {
    ...(await buildDidDocument(did, k2.publicKey)),
    rotations: [await rotateKey(k1.privateKey, k2.publicKey, at + 1000)],
  };
  const viaChain = await verifyRelease(manifest, { signature: sig, resolve: async () => rotated });
  assert.equal(viaChain.signature, "verified");
  assert.equal(viaChain.rotation?.via.length, 2);
  // Witnessed after the retirement: retired.
  const late = await attestRelease(manifest, { did, privateKey: k1.privateKey }, [
    new NotaryWitness(notary.privateKey, { clock: () => at + 5000 }),
  ]);
  assert.equal(
    (await verifyRelease(manifest, { signature: late, resolve: async () => rotated })).signature,
    "retired",
  );
  // The wrong key's document: forged. A signature over another release: forged.
  const other = await generateKeyPair();
  const wrong = await verifyRelease(manifest, {
    signature: sig,
    resolve: async () => buildDidDocument(did, other.publicKey),
  });
  assert.equal(wrong.signature, "forged");
  assert.equal(wrong.ok, false);
  const otherManifest = await manifestFor({ ...meta, epoch: 1 }, { dist: dir });
  const moved = await verifyRelease(otherManifest, { signature: sig, resolve: async () => doc });
  assert.equal(moved.signature, "forged");
  assert.match(moved.reasons[0]!, /different digest/);
});

test("the SBOM from npm names exactly the lockfile's packages (the whole tree: npm's --omit dev also drops production packages shared with dev dependencies)", () => {
  const sbom = JSON.parse(
    execFileSync("npm", ["sbom", "--sbom-format", "spdx"], {
      encoding: "utf8",
      shell: true,
    }),
  ) as { spdxVersion: string; packages: { name: string; versionInfo: string }[] };
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
    packages: Record<string, { version: string; dev?: boolean; optional?: boolean }>;
  };
  // Optional packages are platform binaries: the lockfile lists every platform's, npm
  // installs one platform's, and the SBOM names what is installed.
  const fromLock = new Set<string>();
  const optional = new Set<string>();
  for (const [path, p] of Object.entries(lock.packages)) {
    if (path === "") continue;
    const name = `${path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)}@${p.version}`;
    if (p.optional) {
      optional.add(name);
      continue;
    }
    fromLock.add(name);
  }
  const fromSbom = new Set(sbom.packages.slice(1).map((p) => `${p.name}@${p.versionInfo}`));
  const onlyLock = [...fromLock].filter((x) => !fromSbom.has(x));
  const onlySbom = [...fromSbom].filter((x) => !fromLock.has(x) && !optional.has(x));
  assert.deepEqual({ onlyLock, onlySbom }, { onlyLock: [], onlySbom: [] });
  assert.ok(fromSbom.size > 20);
});
