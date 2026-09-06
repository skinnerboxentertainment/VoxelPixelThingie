/**
 * UUID version 7 (RFC 9562): a 48-bit millisecond timestamp, then random
 * bits, laid out so that ids sort by minting time as plain strings. Within
 * one millisecond a monotonic 12-bit counter keeps minting order, so a
 * process that mints 10,000 ids in a burst still gets them in order.
 * Works in Node 22 and browsers through globalThis.crypto.
 */

let lastMs = 0;
let counter = 0;

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function uuidv7(now: number = Date.now()): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    counter = (counter + 1) & 0xfff;
    if (counter === 0) ms += 1; // counter wrapped: borrow a millisecond
  } else {
    counter = randomBytes(2)[0]! & 0x7ff; // start low so a burst has room
  }
  lastMs = ms;

  const b = new Uint8Array(16);
  // 48-bit timestamp, big-endian.
  b[0] = (ms / 2 ** 40) & 0xff;
  b[1] = (ms / 2 ** 32) & 0xff;
  b[2] = (ms / 2 ** 24) & 0xff;
  b[3] = (ms / 2 ** 16) & 0xff;
  b[4] = (ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  // Version 7 in the top nibble, counter in the remaining 12 bits.
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  // Variant 10xx, then 62 random bits.
  const r = randomBytes(8);
  b[8] = 0x80 | (r[0]! & 0x3f);
  for (let i = 1; i < 8; i++) b[8 + i] = r[i]!;

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(s: string): boolean {
  return UUID_RE.test(s);
}
