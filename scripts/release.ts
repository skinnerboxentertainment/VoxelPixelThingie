/**
 * Reproducible, attested releases (PLAN-4.md Phase 22, ADR 0016). A
 * release manifest lists every built file with its SHA-256 and carries
 * one digest over the list; anyone who rebuilds from the same commit gets
 * the same manifest. The digest is what gets signed with the container
 * key and witnessed (Phase 18), and what a verifier recomputes.
 *
 * This module is the library; release-build, release-attest, and
 * release-verify are the commands.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { assertionKeys, type DidDocument, rotationPath } from "../src/did.ts";
import { keyId, type PrivateKeyJwk, publicOf, signText, verifyText } from "../src/keys.ts";
import { type Witness, type WitnessProof, type WitnessTrust, type WitnessVerdict, verifyWitness } from "../src/witness.ts";

export const RELEASE_FORMAT = "vpb-release/1";
export const RELEASE_SIGNATURE_FORMAT = "vpb-release-signature/1";

export interface ReleaseFile {
  /** Relative to the tree root, forward slashes. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseManifest {
  format: typeof RELEASE_FORMAT;
  /** package.json version. */
  version: string;
  /** The commit built, full SHA. */
  commit: string;
  /** SOURCE_DATE_EPOCH the build ran under: the commit's time, seconds. */
  epoch: number;
  /** Trees built, by name, each a sorted file list. */
  trees: Record<string, ReleaseFile[]>;
  /** SHA-256 over releaseText(manifest). */
  digest: string;
}

export interface ReleaseSignature {
  format: typeof RELEASE_SIGNATURE_FORMAT;
  digest: string;
  did: string;
  keyId: string;
  alg: "EdDSA";
  value: string;
  signed: number;
  witness?: WitnessProof[];
}

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir`, sorted by path, with its hash. */
export async function hashTree(dir: string): Promise<ReleaseFile[]> {
  const out: ReleaseFile[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(p);
        out.push({ path: relative(dir, p).split(sep).join("/"), sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  };
  await walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The text the digest covers: everything but the digest, keys in a fixed order. */
export function releaseText(m: Omit<ReleaseManifest, "digest">): string {
  const trees: Record<string, ReleaseFile[]> = {};
  for (const name of Object.keys(m.trees).sort())
    trees[name] = [...m.trees[name]!]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));
  return JSON.stringify({
    format: m.format,
    version: m.version,
    commit: m.commit,
    epoch: m.epoch,
    trees,
  });
}

export async function manifestFor(
  meta: { version: string; commit: string; epoch: number },
  trees: Record<string, string>,
): Promise<ReleaseManifest> {
  const hashed: Record<string, ReleaseFile[]> = {};
  for (const [name, dir] of Object.entries(trees)) hashed[name] = await hashTree(dir);
  const body = { format: RELEASE_FORMAT, ...meta, trees: hashed } as const;
  return { ...body, digest: sha256(releaseText(body)) };
}

/** The text the signature covers. */
export const signedText = (digest: string): string => `${RELEASE_SIGNATURE_FORMAT}\n${digest}`;

export async function attestRelease(
  manifest: ReleaseManifest,
  signer: { did: string; privateKey: PrivateKeyJwk },
  witnesses: Witness[] = [],
): Promise<ReleaseSignature> {
  const sig: ReleaseSignature = {
    format: RELEASE_SIGNATURE_FORMAT,
    digest: manifest.digest,
    did: signer.did,
    keyId: await keyId(publicOf(signer.privateKey)),
    alg: "EdDSA",
    value: await signText(signer.privateKey, signedText(manifest.digest)),
    signed: Date.now(),
  };
  if (witnesses.length) {
    sig.witness = [];
    const witnessed = sha256(sig.value);
    for (const w of witnesses) sig.witness.push(await w.attest(witnessed));
  }
  return sig;
}

export interface ReleaseVerdict {
  ok: boolean;
  /** Files whose bytes differ from the manifest, or are missing, by tree. */
  mismatches: { tree: string; path: string; reason: "changed" | "missing" | "extra" }[];
  /** True when the recomputed digest equals the manifest's. */
  digestOk: boolean;
  signature: "none" | "verified" | "forged" | "unresolved" | "retired";
  rotation?: { via: string[]; retired: number };
  witnesses?: WitnessVerdict[];
  witnessedAt?: number;
  /** Public provenance (in-toto/SLSA on a transparency log): not checked here; a Decision. */
  provenance: "not checked";
  reasons: string[];
}

export interface VerifyReleaseOptions {
  /** The built trees to check against the manifest, by name. Missing trees are skipped. */
  trees?: Record<string, string>;
  signature?: ReleaseSignature;
  resolve?: (did: string) => Promise<DidDocument>;
  trust?: WitnessTrust;
}

export async function verifyRelease(
  manifest: ReleaseManifest,
  opts: VerifyReleaseOptions = {},
): Promise<ReleaseVerdict> {
  const reasons: string[] = [];
  const mismatches: ReleaseVerdict["mismatches"] = [];
  const { digest, ...body } = manifest;
  const digestOk = sha256(releaseText(body)) === digest;
  if (!digestOk) reasons.push("the manifest's digest is not the digest of its contents");
  for (const [tree, dir] of Object.entries(opts.trees ?? {})) {
    const expected = manifest.trees[tree];
    if (!expected) {
      reasons.push(`the manifest has no tree ${tree}`);
      continue;
    }
    const actual = new Map((await hashTree(dir)).map((f) => [f.path, f]));
    for (const f of expected) {
      const a = actual.get(f.path);
      if (!a) mismatches.push({ tree, path: f.path, reason: "missing" });
      else if (a.sha256 !== f.sha256) mismatches.push({ tree, path: f.path, reason: "changed" });
      actual.delete(f.path);
    }
    for (const path of actual.keys()) mismatches.push({ tree, path, reason: "extra" });
  }
  if (mismatches.length) reasons.push(`${mismatches.length} file(s) differ from the manifest, first ${mismatches[0]!.tree}/${mismatches[0]!.path} (${mismatches[0]!.reason})`);

  let signature: ReleaseVerdict["signature"] = "none";
  let rotation: ReleaseVerdict["rotation"];
  let witnesses: WitnessVerdict[] | undefined;
  let witnessedAt: number | undefined;
  const sig = opts.signature;
  if (sig) {
    signature = "unresolved";
    if (sig.digest !== digest) {
      signature = "forged";
      reasons.push("the signature is over a different digest");
    } else {
      if (sig.witness?.length) {
        witnesses = [];
        const witnessed = sha256(sig.value);
        for (const p of sig.witness) {
          const v = await verifyWitness(p, witnessed, opts.trust);
          witnesses.push(v);
          if (v.ok && v.time !== undefined && (witnessedAt === undefined || v.time < witnessedAt)) witnessedAt = v.time;
        }
      }
      if (opts.resolve) {
        try {
          const doc = await opts.resolve(sig.did);
          const text = signedText(digest);
          let good = false;
          for (const key of assertionKeys(doc)) if (await verifyText(key, text, sig.value)) good = true;
          if (!good && doc.rotations?.length) {
            const path = await rotationPath(doc, sig.keyId);
            if (path.ok && path.key && (await verifyText(path.key, text, sig.value))) {
              good = true;
              rotation = { via: path.via, retired: path.retired! };
            }
          }
          signature = good ? "verified" : "forged";
          if (good && rotation && witnessedAt !== undefined && witnessedAt > rotation.retired) signature = "retired";
          if (signature === "forged") reasons.push("the signature does not verify against the DID document");
          if (signature === "retired") reasons.push("signed by a key after it was retired");
        } catch (err) {
          signature = "unresolved";
          reasons.push(`the DID could not be resolved: ${(err as Error).message}`);
        }
      }
    }
  }
  const ok = digestOk && mismatches.length === 0 && signature !== "forged" && signature !== "retired";
  return {
    ok,
    mismatches,
    digestOk,
    signature,
    ...(rotation ? { rotation } : {}),
    ...(witnesses ? { witnesses } : {}),
    ...(witnessedAt !== undefined ? { witnessedAt } : {}),
    provenance: "not checked",
    reasons,
  };
}
