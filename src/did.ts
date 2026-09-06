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
import { keyId, type PublicKeyJwk, publicOf } from "./keys.ts";

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
