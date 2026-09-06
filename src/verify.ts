/**
 * Integrity for scenes on stores that do not address content by hash
 * (SPEC.md §10.3, §10.9). sealScene writes a SHA-256 per file into the
 * manifest; verifyScene recomputes and compares. sceneDigest is one hash
 * over everything a round trip must reproduce, for comparing a scene opened
 * from two stores.
 *
 * A seal can be signed by the container's key (Phase 11) and witnessed by
 * third parties (Phase 18): each witness attests that the signature's
 * digest existed at a time. A signature by a retired key verifies through
 * the DID document's rotation chain, unless a witness places it after the
 * key's retirement.
 */
import type { Container } from "./container.ts";
import { assertionKeys, type DidDocument, rotationPath } from "./did.ts";
import { keyId, type PrivateKeyJwk, publicOf, signText, verifyText } from "./keys.ts";
import { ledgerPath, mapLimit, passportPath, readManifest, type SceneSignature } from "./scene.ts";
import type { FileStore } from "./store.ts";
import type { Camera } from "./vpb.ts";
import { verifyWitness, type Witness, type WitnessTrust, type WitnessVerdict } from "./witness.ts";

const subtle = () => {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!c) throw new Error("no WebCrypto available");
  return c;
};

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle().digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Signer {
  /** The container's did:web. */
  did: string;
  privateKey: PrivateKeyJwk;
}

export interface SealOptions {
  /** Witnesses asked to attest the signature's digest, in order. */
  witnesses?: Witness[];
}

/** The text a seal signature covers: the scene id, the sorted ids, and every file hash. */
export function sealText(
  scene: string,
  ids: string[],
  hashes: Record<string, { passport: string; events: string }>,
): string {
  return JSON.stringify({ scene, ids: [...ids].sort(), hashes: sortKeys(hashes) });
}

/** What a witness attests: the SHA-256 of the signature value. */
export const witnessedDigest = (signature: Pick<SceneSignature, "value">): Promise<string> =>
  sha256Hex(signature.value);

/**
 * Write a SHA-256 per passport and ledger into manifest.hashes. Call at
 * publish time. With a signer, also sign the seal with the container's key
 * (PLAN-3.md Phase 11), so a reader who resolves the DID can tell the
 * manifest was not rewritten; with witnesses, attach their proofs.
 */
export async function sealScene(
  store: FileStore,
  signer?: Signer,
  opts: SealOptions = {},
): Promise<number> {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error("no manifest.json: not a scene");
  const ids = await store.list("bits");
  const hashes: Record<string, { passport: string; events: string }> = {};
  await mapLimit(ids, 64, async (id) => {
    const [p, l] = await Promise.all([store.read(passportPath(id)), store.read(ledgerPath(id))]);
    hashes[id] = { passport: await sha256Hex(p ?? ""), events: await sha256Hex(l ?? "") };
  });
  const sortedIds = [...ids].sort();
  const sealed: typeof manifest = { ...manifest, ids: sortedIds, hashes: sortKeys(hashes) };
  delete sealed.signature;
  if (signer) {
    const text = sealText(manifest.scene, sortedIds, hashes);
    const kid = await keyId(publicOf(signer.privateKey));
    const signature: SceneSignature = {
      did: signer.did,
      keyId: kid,
      alg: "EdDSA",
      value: await signText(signer.privateKey, text),
      signed: Date.now(),
    };
    if (opts.witnesses?.length) {
      const digest = await witnessedDigest(signature);
      signature.witness = [];
      for (const w of opts.witnesses) signature.witness.push(await w.attest(digest));
    }
    sealed.signature = signature;
  } else if (opts.witnesses?.length) {
    throw new Error("witnesses attest a signature; seal with a signer");
  }
  await store.write("manifest.json", `${JSON.stringify(sealed, null, 2)}\n`);
  return ids.length;
}

/**
 * unsigned: no signature. unresolved: signed, DID not resolved. verified:
 * the key the document asserts with, or a retired key through the rotation
 * chain, signed these hashes. forged: neither did. retired: a retired key
 * signed them, and a witness places the signature after its retirement.
 */
export type SignatureState = "unsigned" | "verified" | "forged" | "unresolved" | "retired";

export interface VerifyReport {
  ok: boolean;
  checked: number;
  mismatches: { id: string; file: "passport" | "events" }[];
  reason?: string;
  /** What the seal's signature said, when the scene carries one and a resolver was given. */
  signature: SignatureState;
  did?: string;
  /** One verdict per witness proof on the seal, in the seal's order. */
  witnesses?: WitnessVerdict[];
  /** The earliest time a holding witness attested the signature. */
  witnessedAt?: number;
  /** Present when the signature verified through a rotation chain. */
  rotation?: { via: string[]; retired: number };
}

export interface VerifyOptions {
  /** Resolves a did:web to its document; without it a signed scene reports "unresolved". */
  resolve?: (did: string) => Promise<DidDocument>;
  /** Which witnesses count as anchored. Proofs are checked either way. */
  trust?: WitnessTrust;
}

/**
 * Recompute every hash in manifest.hashes and report what differs. A
 * signature is checked against the keys the DID document asserts with;
 * "forged" means the manifest's hashes are not what the key signed, and
 * the report is not ok. "unresolved" is not a failure: the hashes still
 * stand on their own, as they did before Phase 11. Witness proofs are
 * checked whether or not the DID resolves.
 */
export async function verifyScene(
  store: FileStore,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const manifest = await readManifest(store);
  if (!manifest)
    return { ok: false, checked: 0, mismatches: [], reason: "not a scene", signature: "unsigned" };
  if (!manifest.hashes)
    return {
      ok: false,
      checked: 0,
      mismatches: [],
      reason: "scene is not sealed",
      signature: "unsigned",
    };
  let signature: SignatureState = "unsigned";
  let witnesses: WitnessVerdict[] | undefined;
  let witnessedAt: number | undefined;
  let rotation: VerifyReport["rotation"];
  const sig = manifest.signature;
  if (sig) {
    signature = "unresolved";
    if (sig.witness?.length) {
      const digest = await witnessedDigest(sig);
      witnesses = [];
      for (const proof of sig.witness) {
        const v = await verifyWitness(proof, digest, opts.trust);
        witnesses.push(v);
        if (v.ok && v.time !== undefined && (witnessedAt === undefined || v.time < witnessedAt))
          witnessedAt = v.time;
      }
    }
    if (opts.resolve) {
      try {
        const doc = await opts.resolve(sig.did);
        const text = sealText(
          manifest.scene,
          manifest.ids ?? Object.keys(manifest.hashes),
          manifest.hashes,
        );
        let good = false;
        for (const key of assertionKeys(doc))
          if (await verifyText(key, text, sig.value)) good = true;
        if (!good && doc.rotations?.length) {
          const path = await rotationPath(doc, sig.keyId);
          if (path.ok && path.key && (await verifyText(path.key, text, sig.value))) {
            good = true;
            rotation = { via: path.via, retired: path.retired! };
          }
        }
        signature = good ? "verified" : "forged";
        if (good && rotation && witnessedAt !== undefined && witnessedAt > rotation.retired)
          signature = "retired";
      } catch {
        signature = "unresolved";
      }
    }
  }
  const mismatches: VerifyReport["mismatches"] = [];
  const entries = Object.entries(manifest.hashes);
  await mapLimit(entries, 64, async ([id, expected]) => {
    const [p, l] = await Promise.all([store.read(passportPath(id)), store.read(ledgerPath(id))]);
    if ((await sha256Hex(p ?? "")) !== expected.passport) mismatches.push({ id, file: "passport" });
    if ((await sha256Hex(l ?? "")) !== expected.events) mismatches.push({ id, file: "events" });
  });
  mismatches.sort((a, b) => (a.id + a.file < b.id + b.file ? -1 : 1));
  const forged = signature === "forged";
  const retired = signature === "retired";
  return {
    ok: mismatches.length === 0 && !forged && !retired,
    checked: entries.length,
    mismatches,
    signature,
    ...(sig ? { did: sig.did } : {}),
    ...(witnesses ? { witnesses } : {}),
    ...(witnessedAt !== undefined ? { witnessedAt } : {}),
    ...(rotation ? { rotation } : {}),
    ...(forged ? { reason: "signature does not match the manifest" } : {}),
    ...(retired ? { reason: "signed by a key after it was retired" } : {}),
  };
}

/** Everything SPEC.md §10.9 says a round trip must reproduce, in a stable shape. */
export function sceneCanonical(grid: Container, camera: Camera = { position: [20, 10, 30] }) {
  grid.evaluate(camera);
  return { scene: grid.id, bits: grid.snapshot() };
}

/** One hash over sceneCanonical. Equal digests from two stores mean the same bits. */
export async function sceneDigest(grid: Container, camera?: Camera): Promise<string> {
  return sha256Hex(JSON.stringify(sceneCanonical(grid, camera)));
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}
