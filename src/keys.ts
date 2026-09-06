/**
 * Container keys (PLAN-3.md Phase 11). Ed25519 through WebCrypto, so the
 * same bytes sign and verify in Node and in the browser. Keys travel as
 * JWK; a private JWK is the owner's to keep and is never written into a
 * passport, a manifest, or a repository.
 */

export interface PublicKeyJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg?: string;
  kid?: string;
}

export interface PrivateKeyJwk extends PublicKeyJwk {
  d: string;
}

const subtle = () => {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!c) throw new Error("no WebCrypto available");
  return c;
};

const enc = new TextEncoder();

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const s = atob(b64 + pad);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A fresh Ed25519 pair as JWKs. */
export async function generateKeyPair(): Promise<{
  publicKey: PublicKeyJwk;
  privateKey: PrivateKeyJwk;
}> {
  const pair = (await subtle().generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = (await subtle().exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const priv = (await subtle().exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return {
    publicKey: { kty: "OKP", crv: "Ed25519", x: pub.x!, alg: "EdDSA" },
    privateKey: { kty: "OKP", crv: "Ed25519", x: priv.x!, d: priv.d!, alg: "EdDSA" },
  };
}

/** The public half of a private JWK. */
export function publicOf(key: PrivateKeyJwk | PublicKeyJwk): PublicKeyJwk {
  const { kty, crv, x } = key;
  return { kty, crv, x, alg: "EdDSA", ...(key.kid ? { kid: key.kid } : {}) };
}

async function importKey(
  jwk: PublicKeyJwk | PrivateKeyJwk,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  const { kty, crv, x } = jwk;
  const d = (jwk as PrivateKeyJwk).d;
  const material: JsonWebKey = { kty, crv, x, ...(d && usage === "sign" ? { d } : {}) };
  return subtle().importKey("jwk", material, { name: "Ed25519" }, false, [usage]);
}

/** Sign UTF-8 text; the signature is base64url of the 64 raw bytes. */
export async function signText(privateKey: PrivateKeyJwk, text: string): Promise<string> {
  const key = await importKey(privateKey, "sign");
  return toBase64Url(await subtle().sign("Ed25519", key, enc.encode(text)));
}

/** True when the signature was made over exactly this text by the key's private half. */
export async function verifyText(
  publicKey: PublicKeyJwk,
  text: string,
  signature: string,
): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromBase64Url(signature);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const key = await importKey(publicOf(publicKey), "verify");
  return subtle().verify("Ed25519", key, sig, enc.encode(text));
}

/** A stable key id: the first 16 hex characters of SHA-256 over the public x coordinate. */
export async function keyId(publicKey: PublicKeyJwk): Promise<string> {
  const digest = await subtle().digest("SHA-256", enc.encode(publicKey.x));
  return Array.from(new Uint8Array(digest).subarray(0, 8), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
