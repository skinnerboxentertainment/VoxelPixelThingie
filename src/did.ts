/**
 * did:web for containers (PLAN-3.md Phase 11; W3C DIDs 1.1, did:web
 * method). A container's DID names the host and path where its DID
 * document is served; the document carries the container's public key
 * and the places its scene, passport page, and EPCIS export live. A bit's
 * DID is the container's DID plus a path, so it is derivable and needs no
 * document of its own.
 *
 *   did:web:example.org:scenes:frame:<container id>
 *     → https://example.org/scenes/frame/<container id>/did.json
 *   did:web:example.org
 *     → https://example.org/.well-known/did.json
 */
import {
  keyId,
  type PrivateKeyJwk,
  type PublicKeyJwk,
  publicOf,
  signText,
  verifyText,
} from "./keys.ts";

export interface DidDocument {
  "@context": string[];
  id: string;
  verificationMethod: {
    id: string;
    type: "JsonWebKey2020";
    controller: string;
    publicKeyJwk: PublicKeyJwk;
  }[];
  assertionMethod: string[];
  service?: { id: string; type: string; serviceEndpoint: string }[];
  /**
   * Key rotations, oldest first (PLAN-4 Phase 18, ADR 0013). Not a DID Core
   * property; a plain-JSON extension so the chain travels with the document.
   */
  rotations?: RotationStatement[];
}

/**
 * A key handing over to its successor, signed by the key being retired.
 * A seal made with `from` verifies through the chain against a document
 * that asserts only `to`; a seal witnessed after `retired` does not.
 */
export interface RotationStatement {
  format: "vpb-rotation/1";
  from: string;
  fromKey: PublicKeyJwk;
  to: string;
  toKey: PublicKeyJwk;
  /** ms since the epoch: the moment `from` stopped being the container's key. */
  retired: number;
  /** base64url Ed25519 signature by `from` over rotationText. */
  signature: string;
}

const bare = (k: PublicKeyJwk): PublicKeyJwk => ({ kty: k.kty, crv: k.crv, x: k.x });

export const rotationText = (r: Omit<RotationStatement, "signature">): string =>
  JSON.stringify({
    format: r.format,
    from: r.from,
    fromKey: bare(r.fromKey),
    to: r.to,
    toKey: bare(r.toKey),
    retired: r.retired,
  });

/** Retire `oldKey` in favour of `newKey` at `retired` (now by default). */
export async function rotateKey(
  oldKey: PrivateKeyJwk,
  newKey: PublicKeyJwk,
  retired = Date.now(),
): Promise<RotationStatement> {
  const fromKey = bare(publicOf(oldKey));
  const toKey = bare(newKey);
  const body: Omit<RotationStatement, "signature"> = {
    format: "vpb-rotation/1",
    from: await keyId(fromKey),
    fromKey,
    to: await keyId(toKey),
    toKey,
    retired,
  };
  return { ...body, signature: await signText(oldKey, rotationText(body)) };
}

export interface RotationPath {
  ok: boolean;
  /** Key ids from the seal's key to the current key, inclusive. */
  via: string[];
  /** The public key the seal was made with, when the chain holds. */
  key?: PublicKeyJwk;
  /** When the seal's key was retired, when the chain holds. */
  retired?: number;
  reason?: string;
}

/**
 * Walk `doc.rotations` from `kid` to a key the document asserts with. Each
 * link must be signed by its own `from`, whose id must match its key.
 */
export async function rotationPath(doc: DidDocument, kid: string): Promise<RotationPath> {
  const current = new Set(await Promise.all(assertionKeys(doc).map((k) => keyId(k))));
  if (current.has(kid)) return { ok: true, via: [kid] };
  const via = [kid];
  let at = kid;
  let first: RotationStatement | undefined;
  for (let hops = 0; hops < 64; hops++) {
    const step = (doc.rotations ?? []).find((r) => r.from === at);
    if (!step) return { ok: false, via, reason: `no rotation from ${at}` };
    if ((await keyId(step.fromKey)) !== step.from || (await keyId(step.toKey)) !== step.to)
      return {
        ok: false,
        via,
        reason: `rotation from ${at} names keys that do not match their ids`,
      };
    if (!(await verifyText(step.fromKey, rotationText(step), step.signature)))
      return { ok: false, via, reason: `rotation from ${at} is not signed by ${at}` };
    first ??= step;
    via.push(step.to);
    at = step.to;
    if (current.has(at)) return { ok: true, via, key: first.fromKey, retired: first.retired };
  }
  return { ok: false, via, reason: "rotation chain too long" };
}

/** The DID for a container served at host and path. Path segments become colons. */
export function frameDid(host: string, path: string, frameId: string): string {
  const base = ["did:web", host.replace(/:/g, "%3A"), ...path.split("/").filter(Boolean)];
  return `${base.join(":")}:frame:${frameId}`;
}

/** A bit's DID: the container's DID with the bit as a path, as DIDs 1.1 allows. */
export function bitDid(frameDidValue: string, bitId: string): string {
  return `${frameDidValue}/bit/${bitId}`;
}

/** Where a did:web document is fetched from, per the method specification. */
export function didWebUrl(did: string): string {
  const m = /^did:web:([^/?#]+)/.exec(did);
  if (!m) throw new Error(`not a did:web: ${did}`);
  const parts = m[1]!.split(":").map((p) => decodeURIComponent(p));
  const host = parts[0]!;
  const path = parts.slice(1);
  return path.length === 0
    ? `https://${host}/.well-known/did.json`
    : `https://${host}/${path.join("/")}/did.json`;
}

export interface DidDocumentOptions {
  /** Absolute URLs a reader can follow. Each becomes a service entry. */
  services?: { manifest?: string; passport?: string; epcis?: string };
}

/** The document for a container's DID and public key. */
export async function buildDidDocument(
  did: string,
  publicKey: PublicKeyJwk,
  opts: DidDocumentOptions = {},
): Promise<DidDocument> {
  const kid = await keyId(publicKey);
  const vm = `${did}#${kid}`;
  const service: DidDocument["service"] = [];
  const s = opts.services ?? {};
  if (s.manifest)
    service.push({ id: `${did}#scene`, type: "VpbScene", serviceEndpoint: s.manifest });
  if (s.passport)
    service.push({ id: `${did}#passport`, type: "VpbPassportPage", serviceEndpoint: s.passport });
  if (s.epcis)
    service.push({ id: `${did}#epcis`, type: "EpcisDocument", serviceEndpoint: s.epcis });
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: did,
    verificationMethod: [
      {
        id: vm,
        type: "JsonWebKey2020",
        controller: did,
        publicKeyJwk: { ...publicOf(publicKey), kid },
      },
    ],
    assertionMethod: [vm],
    ...(service.length ? { service } : {}),
  };
}

export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The public keys a DID document asserts with, in order. Throws when it cannot be fetched or parsed. */
export async function resolveDidWeb(did: string, fetchFn?: FetchLike): Promise<DidDocument> {
  const f = fetchFn ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error("no fetch available");
  const url = didWebUrl(did);
  const res = await f(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const doc = JSON.parse(await res.text()) as DidDocument;
  if (doc.id !== did) throw new Error(`DID document at ${url} is for ${doc.id}, not ${did}`);
  return doc;
}

/** Public keys named by assertionMethod in a document. */
export function assertionKeys(doc: DidDocument): PublicKeyJwk[] {
  const byId = new Map(doc.verificationMethod.map((m) => [m.id, m.publicKeyJwk]));
  return doc.assertionMethod.map((id) => byId.get(id)).filter((k): k is PublicKeyJwk => !!k);
}
