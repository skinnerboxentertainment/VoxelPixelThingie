/**
 * Storage by content (PLAN-3.md Phase 12): `put` bytes, get back a content
 * id; `get` the id, get back the same bytes from any backend that holds
 * them. The id is a CIDv1 with the raw codec and a SHA-256 multihash, the
 * form IPFS gives a small file added with raw leaves, so an id minted here
 * names the same bytes on an IPFS gateway. (IPFS chunks files over 256 KiB
 * into a DAG whose root id differs; this id still names the bytes, and a
 * pinning backend maps between the two.)
 *
 * A job's result that is too big for a passport goes here, and the event
 * carries the id (SPEC.md §9.7).
 */

export interface Storage {
  put(bytes: Uint8Array): Promise<string>;
  get(cid: string): Promise<Uint8Array | undefined>;
}

const subtle = () => {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!c) throw new Error("no WebCrypto available");
  return c;
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding: the multibase "b" encoding without its prefix. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`not base32: ${ch}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

const CID_VERSION = 0x01;
const CODEC_RAW = 0x55;
const HASH_SHA256 = 0x12;

/** CIDv1, raw codec, sha2-256, multibase base32: "bafkrei…". */
export async function contentId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", bytes as BufferSource));
  const cid = new Uint8Array(4 + digest.length);
  cid.set([CID_VERSION, CODEC_RAW, HASH_SHA256, digest.length], 0);
  cid.set(digest, 4);
  return `b${base32(cid)}`;
}

/** The SHA-256 digest a content id names, or undefined when it is not one of ours. */
export function digestOf(cid: string): Uint8Array | undefined {
  if (!cid.startsWith("b")) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = unbase32(cid.slice(1));
  } catch {
    return undefined;
  }
  if (bytes.length !== 36 || bytes[0] !== CID_VERSION || bytes[1] !== CODEC_RAW) return undefined;
  if (bytes[2] !== HASH_SHA256 || bytes[3] !== 32) return undefined;
  return bytes.subarray(4);
}

export const isContentId = (s: unknown): s is string =>
  typeof s === "string" && digestOf(s) !== undefined;

/** Reference backend: a map in memory. */
export class MemoryStorage implements Storage {
  readonly #blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<string> {
    const cid = await contentId(bytes);
    if (!this.#blobs.has(cid)) this.#blobs.set(cid, new Uint8Array(bytes));
    return cid;
  }

  async get(cid: string): Promise<Uint8Array | undefined> {
    const b = this.#blobs.get(cid);
    return b ? new Uint8Array(b) : undefined;
  }

  get size(): number {
    return this.#blobs.size;
  }
}

/** A backend that verifies what it hands back against the id, whatever holds the bytes. */
export class VerifyingStorage implements Storage {
  readonly inner: Storage;
  constructor(inner: Storage) {
    this.inner = inner;
  }

  put(bytes: Uint8Array): Promise<string> {
    return this.inner.put(bytes);
  }

  async get(cid: string): Promise<Uint8Array | undefined> {
    const bytes = await this.inner.get(cid);
    if (!bytes) return undefined;
    if ((await contentId(bytes)) !== cid)
      throw new Error(`storage returned the wrong bytes for ${cid}`);
    return bytes;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const putText = (s: Storage, text: string) => s.put(enc.encode(text));
export const getText = async (s: Storage, cid: string) => {
  const b = await s.get(cid);
  return b === undefined ? undefined : dec.decode(b);
};
