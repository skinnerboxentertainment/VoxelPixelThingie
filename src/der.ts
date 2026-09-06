/**
 * A DER reader and writer for exactly the shapes the witness path needs
 * (PLAN-4.md Phase 18): SEQUENCE, SET, INTEGER, OCTET STRING, OBJECT
 * IDENTIFIER, BOOLEAN, NULL, GeneralizedTime, UTCTime, the string types
 * that appear in certificate names, and context-specific tags. Anything
 * else parses as an opaque node, and indefinite lengths and multi-byte
 * tag numbers are refused: this is not a general ASN.1 library.
 */

export interface DerNode {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  /** The tag number within its class. */
  number: number;
  /** The whole TLV, header included. */
  bytes: Uint8Array;
  /** The content octets. */
  content: Uint8Array;
  /** Parsed only for constructed nodes. */
  children: DerNode[];
}

export const TAG = {
  BOOLEAN: 1,
  INTEGER: 2,
  BIT_STRING: 3,
  OCTET_STRING: 4,
  NULL: 5,
  OID: 6,
  UTF8_STRING: 12,
  SEQUENCE: 16,
  SET: 17,
  PRINTABLE_STRING: 19,
  T61_STRING: 20,
  IA5_STRING: 22,
  UTC_TIME: 23,
  GENERALIZED_TIME: 24,
} as const;

/** Parse one TLV at `offset`. Constructed nodes are parsed recursively. */
export function parseDer(bytes: Uint8Array, offset = 0): DerNode {
  const { node, next } = parseOne(bytes, offset);
  if (next !== bytes.length && offset === 0)
    throw new Error(`DER: ${bytes.length - next} trailing bytes`);
  return node;
}

/** Parse every TLV in `bytes` back to back. */
export function parseDerAll(bytes: Uint8Array): DerNode[] {
  const out: DerNode[] = [];
  let at = 0;
  while (at < bytes.length) {
    const { node, next } = parseOne(bytes, at);
    out.push(node);
    at = next;
  }
  return out;
}

function parseOne(bytes: Uint8Array, offset: number): { node: DerNode; next: number } {
  if (offset >= bytes.length) throw new Error("DER: unexpected end");
  const first = bytes[offset]!;
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  const number = first & 0x1f;
  if (number === 0x1f) throw new Error("DER: multi-byte tag numbers are not supported");
  let at = offset + 1;
  if (at >= bytes.length) throw new Error("DER: missing length");
  let length = bytes[at]!;
  at++;
  if (length === 0x80) throw new Error("DER: indefinite length is not DER");
  if (length > 0x80) {
    const n = length & 0x7f;
    if (n > 4) throw new Error("DER: length too long");
    length = 0;
    for (let i = 0; i < n; i++) {
      if (at >= bytes.length) throw new Error("DER: truncated length");
      length = length * 256 + bytes[at]!;
      at++;
    }
  }
  const end = at + length;
  if (end > bytes.length) throw new Error("DER: content runs past the end");
  const content = bytes.subarray(at, end);
  const children = constructed ? parseDerAll(content) : [];
  return {
    node: { cls, constructed, number, bytes: bytes.subarray(offset, end), content, children },
    next: end,
  };
}

const isUniversal = (n: DerNode, tag: number) => n.cls === 0 && n.number === tag;

export function expect(n: DerNode, tag: number, what: string): DerNode {
  if (!isUniversal(n, tag))
    throw new Error(`DER: expected ${what} (tag ${tag}), got class ${n.cls} tag ${n.number}`);
  return n;
}

/** The child with a context-specific tag number, or undefined. */
export function contextChild(n: DerNode, number: number): DerNode | undefined {
  return n.children.find((c) => c.cls === 2 && c.number === number);
}

export function oidOf(n: DerNode): string {
  expect(n, TAG.OID, "OBJECT IDENTIFIER");
  const b = n.content;
  const arcs: number[] = [];
  let value = 0;
  for (let i = 0; i < b.length; i++) {
    value = value * 128 + (b[i]! & 0x7f);
    if ((b[i]! & 0x80) === 0) {
      if (arcs.length === 0) {
        arcs.push(value < 80 ? Math.floor(value / 40) : 2, value < 80 ? value % 40 : value - 80);
      } else arcs.push(value);
      value = 0;
    }
  }
  return arcs.join(".");
}

/** A non-negative INTEGER as a hex string, without leading zeros. */
export function integerHexOf(n: DerNode): string {
  expect(n, TAG.INTEGER, "INTEGER");
  let hex = Array.from(n.content, (x) => x.toString(16).padStart(2, "0")).join("");
  hex = hex.replace(/^(00)+(?=..)/, "");
  return hex;
}

export function integerOf(n: DerNode): number {
  const hex = integerHexOf(n);
  if (hex.length > 12) throw new Error("DER: integer too large for a number");
  return Number.parseInt(hex, 16);
}

export function booleanOf(n: DerNode): boolean {
  expect(n, TAG.BOOLEAN, "BOOLEAN");
  return n.content[0] !== 0;
}

export function octetsOf(n: DerNode): Uint8Array {
  expect(n, TAG.OCTET_STRING, "OCTET STRING");
  return n.content;
}

/** The content of a BIT STRING with its unused-bits octet dropped. */
export function bitStringOf(n: DerNode): Uint8Array {
  expect(n, TAG.BIT_STRING, "BIT STRING");
  if (n.content[0] !== 0) throw new Error("DER: BIT STRING with unused bits");
  return n.content.subarray(1);
}

const decoder = new TextDecoder();

export function stringOf(n: DerNode): string {
  if (n.cls !== 0) throw new Error("DER: not a string");
  switch (n.number) {
    case TAG.UTF8_STRING:
    case TAG.PRINTABLE_STRING:
    case TAG.IA5_STRING:
    case TAG.T61_STRING:
      return decoder.decode(n.content);
    case 30: // BMPString, UTF-16BE
      return String.fromCharCode(
        ...Array.from(
          { length: n.content.length / 2 },
          (_, i) => (n.content[2 * i]! << 8) | n.content[2 * i + 1]!,
        ),
      );
    default:
      throw new Error(`DER: unsupported string tag ${n.number}`);
  }
}

/** GeneralizedTime or UTCTime as milliseconds since the epoch. Only the Z forms. */
export function timeOf(n: DerNode): number {
  const text = decoder.decode(n.content);
  if (isUniversal(n, TAG.GENERALIZED_TIME)) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(text);
    if (!m) throw new Error(`DER: GeneralizedTime ${text}`);
    const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, ms);
  }
  if (isUniversal(n, TAG.UTC_TIME)) {
    const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(text);
    if (!m) throw new Error(`DER: UTCTime ${text}`);
    const yy = +m[1]!;
    return Date.UTC(
      yy >= 50 ? 1900 + yy : 2000 + yy,
      +m[2]! - 1,
      +m[3]!,
      +m[4]!,
      +m[5]!,
      +(m[6] ?? 0),
    );
  }
  throw new Error("DER: not a time");
}

// Writing.

function lengthBytes(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return [0x80 | out.length, ...out];
}

export function tlv(tag: number, content: Uint8Array | number[]): Uint8Array {
  const c = content instanceof Uint8Array ? content : Uint8Array.from(content);
  const head = [tag, ...lengthBytes(c.length)];
  const out = new Uint8Array(head.length + c.length);
  out.set(head, 0);
  out.set(c, head.length);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const sequence = (...parts: Uint8Array[]): Uint8Array => tlv(0x30, concat(...parts));
export const set = (...parts: Uint8Array[]): Uint8Array => tlv(0x31, concat(...parts));
export const octetString = (bytes: Uint8Array): Uint8Array => tlv(TAG.OCTET_STRING, bytes);
export const nullValue = (): Uint8Array => tlv(TAG.NULL, []);
export const boolean = (v: boolean): Uint8Array => tlv(TAG.BOOLEAN, [v ? 0xff : 0]);

/** A non-negative INTEGER from big-endian bytes (a leading zero is added when the high bit is set). */
export function integer(value: number | Uint8Array): Uint8Array {
  let bytes: number[];
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0)
      throw new Error("DER: integer must be a non-negative integer");
    bytes = [];
    let v = value;
    do {
      bytes.unshift(v % 256);
      v = Math.floor(v / 256);
    } while (v > 0);
  } else {
    bytes = Array.from(value);
    while (bytes.length > 1 && bytes[0] === 0 && (bytes[1]! & 0x80) === 0) bytes.shift();
  }
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(TAG.INTEGER, bytes);
}

export function oid(text: string): Uint8Array {
  const arcs = text.split(".").map(Number);
  if (arcs.length < 2) throw new Error(`DER: bad OID ${text}`);
  const out: number[] = [];
  const push = (v: number) => {
    const chunk: number[] = [v & 0x7f];
    let rest = Math.floor(v / 128);
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    out.push(...chunk);
  };
  push(arcs[0]! * 40 + arcs[1]!);
  for (const a of arcs.slice(2)) push(a);
  return tlv(TAG.OID, out);
}

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) throw new Error("bad hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
