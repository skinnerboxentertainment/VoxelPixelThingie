/**
 * Witnesses (PLAN-4.md Phase 18, ADR 0013). A seal is the container's
 * signature; a witness is a third party attesting that a digest existed
 * at a time. With both, a scene stays checkable after the container's key
 * is gone or its DID's host is down: the witness's word about the time
 * stands on its own.
 *
 * The contract is one call, `attest(digest)`, and one verifier. Two
 * backends: a notary, an Ed25519 key of anyone's signing `{ digest, time }`
 * (the in-process reference, no network, no account), and an RFC 3161
 * time-stamp authority (src/rfc3161.ts). A verdict says whether the proof
 * holds for this digest, when, by whom, and whether the witness is one the
 * caller said to trust ("anchored"); an unanchored witness still holds,
 * it is just nobody in particular.
 */
import {
  keyId,
  type PrivateKeyJwk,
  type PublicKeyJwk,
  publicOf,
  signText,
  verifyText,
} from "./keys.ts";
import { type Rfc3161Options, requestTimeStamp, verifyTimeStampToken } from "./rfc3161.ts";

export type WitnessKind = "vpb-notary/1" | "rfc3161/1";

export interface WitnessProof {
  kind: WitnessKind;
  /** `notary:<key id>` or the authority's URL. */
  witness: string;
  /** The SHA-256 hex digest the proof covers. */
  digest: string;
  /** base64url signature (notary) or base64 TimeStampToken (RFC 3161). */
  proof: string;
  /** The time the witness asserted, ms since the epoch, as the proof carries it. */
  time: number;
  /** The notary's public key, so the proof can be checked without a trust list. */
  key?: PublicKeyJwk;
}

export interface Witness {
  attest(digest: string): Promise<WitnessProof>;
}

export interface WitnessTrust {
  /** Notary public keys the caller trusts. */
  notaries?: PublicKeyJwk[];
  /** SHA-256 fingerprints of time-stamp authority signer certificates the caller trusts. */
  tsaFingerprints?: string[];
}

export interface WitnessVerdict {
  ok: boolean;
  kind: WitnessKind;
  witness: string;
  /** When the witness said the digest existed. Present when the proof parsed, even if it failed. */
  time?: number;
  /** True when the witness is in the caller's trust list. */
  anchored: boolean;
  /** The signer's subject (RFC 3161) or key id (notary). */
  signer?: string;
  reason?: string;
}

export const notaryText = (p: Pick<WitnessProof, "digest" | "time">, kid: string): string =>
  JSON.stringify({
    kind: "vpb-notary/1",
    witness: `notary:${kid}`,
    digest: p.digest,
    time: p.time,
  });

/** The reference witness: a key signing the digest and the time it saw it. */
export class NotaryWitness implements Witness {
  readonly #key: PrivateKeyJwk;
  readonly #clock: () => number;

  constructor(privateKey: PrivateKeyJwk, opts: { clock?: () => number } = {}) {
    this.#key = privateKey;
    this.#clock = opts.clock ?? (() => Date.now());
  }

  async attest(digest: string): Promise<WitnessProof> {
    const key = publicOf(this.#key);
    const kid = await keyId(key);
    const time = this.#clock();
    const text = notaryText({ digest, time }, kid);
    return {
      kind: "vpb-notary/1",
      witness: `notary:${kid}`,
      digest,
      proof: await signText(this.#key, text),
      time,
      key: { kty: key.kty, crv: key.crv, x: key.x },
    };
  }
}

/** An RFC 3161 authority behind the same contract. */
export class Rfc3161Witness implements Witness {
  readonly url: string;
  readonly #opts: Rfc3161Options;

  constructor(url: string, opts: Rfc3161Options = {}) {
    this.url = url;
    this.#opts = opts;
  }

  async attest(digest: string): Promise<WitnessProof> {
    const token = await requestTimeStamp(this.url, digest, this.#opts);
    const verdict = await verifyTimeStampToken(token, digest);
    if (!verdict.ok || verdict.time === undefined)
      throw new Error(`${this.url} returned a token that does not verify: ${verdict.reason}`);
    return {
      kind: "rfc3161/1",
      witness: this.url,
      digest,
      proof: toBase64(token),
      time: verdict.time,
    };
  }
}

/** Check one proof against the digest it should cover. */
export async function verifyWitness(
  proof: WitnessProof,
  digest: string,
  trust: WitnessTrust = {},
): Promise<WitnessVerdict> {
  const base = { kind: proof.kind, witness: proof.witness };
  if (proof.digest !== digest)
    return {
      ...base,
      ok: false,
      anchored: false,
      time: proof.time,
      reason: "the proof covers a different digest",
    };
  if (proof.kind === "vpb-notary/1") {
    if (!proof.key)
      return {
        ...base,
        ok: false,
        anchored: false,
        time: proof.time,
        reason: "no notary key in the proof",
      };
    const kid = await keyId(proof.key);
    if (proof.witness !== `notary:${kid}`)
      return {
        ...base,
        ok: false,
        anchored: false,
        time: proof.time,
        reason: "the notary key does not match the witness id",
      };
    const good = await verifyText(proof.key, notaryText(proof, kid), proof.proof);
    const anchored = (trust.notaries ?? []).some((k) => k.x === proof.key!.x);
    return good
      ? { ...base, ok: true, anchored, time: proof.time, signer: kid }
      : {
          ...base,
          ok: false,
          anchored,
          time: proof.time,
          signer: kid,
          reason: "the notary signature does not verify",
        };
  }
  if (proof.kind === "rfc3161/1") {
    let token: Uint8Array;
    try {
      token = fromBase64(proof.proof);
    } catch {
      return { ...base, ok: false, anchored: false, reason: "the token is not base64" };
    }
    const v = await verifyTimeStampToken(token, digest);
    const anchored = !!v.signer && (trust.tsaFingerprints ?? []).includes(v.signer.fingerprint);
    const signer = v.signer
      ? `${v.signer.subject} (${v.signer.fingerprint.slice(0, 16)}…)`
      : undefined;
    if (!v.ok)
      return {
        ...base,
        ok: false,
        anchored,
        ...(v.time !== undefined ? { time: v.time } : {}),
        ...(signer ? { signer } : {}),
        reason: v.reason ?? "token failed",
      };
    if (v.time !== proof.time)
      return {
        ...base,
        ok: false,
        anchored,
        time: v.time,
        ...(signer ? { signer } : {}),
        reason: "the proof's time is not the token's genTime",
      };
    return { ...base, ok: true, anchored, time: v.time, ...(signer ? { signer } : {}) };
  }
  return {
    ...base,
    ok: false,
    anchored: false,
    reason: `unknown witness kind ${String((proof as { kind: unknown }).kind)}`,
  };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
