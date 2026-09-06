/**
 * RFC 3161 time-stamp tokens (PLAN-4.md Phase 18): build a request for a
 * SHA-256 imprint, read the response, and verify the token's CMS
 * signature with WebCrypto against the signer certificate the token
 * carries. What verification proves: the authority whose certificate is
 * in the token signed, at `genTime`, a statement that this exact digest
 * existed. What it does not prove: that the certificate chains to a root
 * you trust. Anchoring is a list of certificate fingerprints supplied by
 * the caller; without one the verdict says so.
 *
 * Supported: RSA PKCS#1 v1.5 (rsaEncryption or sha*WithRSAEncryption)
 * and ECDSA on P-256, P-384, P-521, with SHA-256, -384, -512. Anything
 * else is refused by name.
 */
import {
  booleanOf,
  bytesEqual,
  concat,
  contextChild,
  type DerNode,
  expect,
  fromHex,
  hex,
  integer,
  integerHexOf,
  integerOf,
  nullValue,
  octetString,
  octetsOf,
  oid,
  oidOf,
  parseDer,
  sequence,
  stringOf,
  TAG,
  timeOf,
  tlv,
} from "./der.ts";

const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  messageDigest: "1.2.840.113549.1.9.4",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  sha384WithRSA: "1.2.840.113549.1.1.12",
  sha512WithRSA: "1.2.840.113549.1.1.13",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  p521: "1.3.132.0.35",
  subjectKeyIdentifier: "2.5.29.14",
  cn: "2.5.4.3",
  o: "2.5.4.10",
  ou: "2.5.4.11",
  c: "2.5.4.6",
} as const;

const HASH_BY_OID: Record<string, "SHA-256" | "SHA-384" | "SHA-512"> = {
  [OID.sha256]: "SHA-256",
  [OID.sha384]: "SHA-384",
  [OID.sha512]: "SHA-512",
};

/** A copy backed by a plain ArrayBuffer, which WebCrypto and fetch insist on. */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

const subtle = () => {
  const c = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!c) throw new Error("no WebCrypto available");
  return c;
};

export interface TimeStampReqOptions {
  /** Eight random bytes by default. */
  nonce?: Uint8Array;
  /** Ask the authority to include its certificate. Default true; verification needs it. */
  certReq?: boolean;
}

/** A TimeStampReq (RFC 3161 §2.4.1) for a SHA-256 digest given as hex. */
export function buildTimeStampReq(digestHex: string, opts: TimeStampReqOptions = {}): Uint8Array {
  const digest = fromHex(digestHex);
  if (digest.length !== 32) throw new Error("the imprint must be a SHA-256 digest");
  const nonce = opts.nonce ?? crypto.getRandomValues(new Uint8Array(8));
  const certReq = opts.certReq ?? true;
  return sequence(
    integer(1),
    sequence(sequence(oid(OID.sha256), nullValue()), octetString(digest)),
    integer(nonce),
    ...(certReq ? [tlv(TAG.BOOLEAN, [0xff])] : []),
  );
}

export interface ParsedTimeStampReq {
  version: number;
  hashAlgorithm: string;
  imprint: string;
  nonce?: string;
  certReq: boolean;
}

export function parseTimeStampReq(bytes: Uint8Array): ParsedTimeStampReq {
  const req = expect(parseDer(bytes), TAG.SEQUENCE, "TimeStampReq");
  const [version, imprint, ...rest] = req.children;
  const alg = oidOf(imprint!.children[0]!.children[0]!);
  const out: ParsedTimeStampReq = {
    version: integerOf(version!),
    hashAlgorithm: alg,
    imprint: hex(octetsOf(imprint!.children[1]!)),
    certReq: false,
  };
  for (const n of rest) {
    if (n.cls === 0 && n.number === TAG.INTEGER) out.nonce = integerHexOf(n);
    if (n.cls === 0 && n.number === TAG.BOOLEAN) out.certReq = booleanOf(n);
  }
  return out;
}

export interface TimeStampResp {
  /** PKIStatus: 0 granted, 1 granted with modifications, 2 rejection, 3 waiting, 4 and 5 warnings. */
  status: number;
  statusText?: string;
  /** The TimeStampToken (a CMS ContentInfo) when granted. */
  token?: Uint8Array;
}

export function parseTimeStampResp(bytes: Uint8Array): TimeStampResp {
  const resp = expect(parseDer(bytes), TAG.SEQUENCE, "TimeStampResp");
  const statusInfo = expect(resp.children[0]!, TAG.SEQUENCE, "PKIStatusInfo");
  const status = integerOf(statusInfo.children[0]!);
  const out: TimeStampResp = { status };
  const texts = statusInfo.children[1];
  if (texts && texts.cls === 0 && texts.number === TAG.SEQUENCE)
    out.statusText = texts.children.map((t) => stringOf(t)).join("; ");
  const token = resp.children[1];
  if (token) out.token = token.bytes;
  return out;
}

export interface TokenVerdict {
  ok: boolean;
  reason?: string;
  /** genTime, ms since the epoch. */
  time?: number;
  imprint?: string;
  policy?: string;
  serial?: string;
  nonce?: string;
  signer?: { subject: string; fingerprint: string; algorithm: string };
}

interface Certificate {
  node: DerNode;
  serial: string;
  issuer: Uint8Array;
  subject: string;
  spki: DerNode;
  subjectKeyId?: string;
}

function nameToString(name: DerNode): string {
  const parts: string[] = [];
  const labels: Record<string, string> = {
    [OID.cn]: "CN",
    [OID.o]: "O",
    [OID.ou]: "OU",
    [OID.c]: "C",
  };
  for (const rdn of name.children)
    for (const atv of rdn.children) {
      const type = oidOf(atv.children[0]!);
      const label = labels[type];
      if (!label) continue;
      try {
        parts.push(`${label}=${stringOf(atv.children[1]!)}`);
      } catch {
        // an unusual string type; skip the attribute
      }
    }
  return parts.join(", ");
}

function parseCertificate(node: DerNode): Certificate {
  expect(node, TAG.SEQUENCE, "Certificate");
  const tbs = expect(node.children[0]!, TAG.SEQUENCE, "tbsCertificate");
  let i = 0;
  if (tbs.children[0]!.cls === 2) i = 1; // [0] EXPLICIT version
  const serial = integerHexOf(tbs.children[i]!);
  const issuer = tbs.children[i + 2]!;
  const subject = tbs.children[i + 4]!;
  const spki = tbs.children[i + 5]!;
  let subjectKeyId: string | undefined;
  const extensions = contextChild(tbs, 3);
  if (extensions)
    for (const ext of extensions.children[0]?.children ?? []) {
      if (oidOf(ext.children[0]!) === OID.subjectKeyIdentifier) {
        const value = ext.children[ext.children.length - 1]!;
        subjectKeyId = hex(octetsOf(parseDer(octetsOf(value))));
      }
    }
  return {
    node,
    serial,
    issuer: issuer.bytes,
    subject: nameToString(subject),
    spki,
    ...(subjectKeyId ? { subjectKeyId } : {}),
  };
}

async function importSpki(
  spki: DerNode,
  hash: "SHA-256" | "SHA-384" | "SHA-512",
): Promise<{ key: CryptoKey; algorithm: string; ecBytes?: number }> {
  const algId = spki.children[0]!;
  const algOid = oidOf(algId.children[0]!);
  if (algOid === OID.rsaEncryption) {
    const key = await subtle().importKey(
      "spki",
      buf(spki.bytes),
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );
    return { key, algorithm: `RSA PKCS#1 v1.5 with ${hash}` };
  }
  if (algOid === OID.ecPublicKey) {
    const curve = oidOf(algId.children[1]!);
    const named =
      curve === OID.p256
        ? "P-256"
        : curve === OID.p384
          ? "P-384"
          : curve === OID.p521
            ? "P-521"
            : undefined;
    if (!named) throw new Error(`unsupported curve ${curve}`);
    const key = await subtle().importKey(
      "spki",
      buf(spki.bytes),
      { name: "ECDSA", namedCurve: named },
      false,
      ["verify"],
    );
    return {
      key,
      algorithm: `ECDSA ${named} with ${hash}`,
      ecBytes: named === "P-256" ? 32 : named === "P-384" ? 48 : 66,
    };
  }
  throw new Error(`unsupported public key algorithm ${algOid}`);
}

/** ECDSA-Sig-Value SEQUENCE { r, s } to the raw r||s WebCrypto expects. */
function ecdsaRaw(der: Uint8Array, size: number): Uint8Array {
  const sig = expect(parseDer(der), TAG.SEQUENCE, "ECDSA-Sig-Value");
  const pad = (n: DerNode) => {
    let b = n.content;
    while (b.length > size && b[0] === 0) b = b.subarray(1);
    if (b.length > size) throw new Error("ECDSA integer too long");
    const out = new Uint8Array(size);
    out.set(b, size - b.length);
    return out;
  };
  return concat(pad(sig.children[0]!), pad(sig.children[1]!));
}

function hashForSignature(sigOid: string, digestHash: "SHA-256" | "SHA-384" | "SHA-512") {
  switch (sigOid) {
    case OID.rsaEncryption:
      return { hash: digestHash, ec: false };
    case OID.sha256WithRSA:
      return { hash: "SHA-256" as const, ec: false };
    case OID.sha384WithRSA:
      return { hash: "SHA-384" as const, ec: false };
    case OID.sha512WithRSA:
      return { hash: "SHA-512" as const, ec: false };
    case OID.ecdsaSha256:
      return { hash: "SHA-256" as const, ec: true };
    case OID.ecdsaSha384:
      return { hash: "SHA-384" as const, ec: true };
    case OID.ecdsaSha512:
      return { hash: "SHA-512" as const, ec: true };
    default:
      throw new Error(`unsupported signature algorithm ${sigOid}`);
  }
}

/**
 * Verify a TimeStampToken against the digest it is supposed to cover.
 * Every step that could fail returns a verdict naming the step.
 */
export async function verifyTimeStampToken(
  token: Uint8Array,
  digestHex: string,
): Promise<TokenVerdict> {
  try {
    const contentInfo = expect(parseDer(token), TAG.SEQUENCE, "ContentInfo");
    if (oidOf(contentInfo.children[0]!) !== OID.signedData)
      return { ok: false, reason: "not CMS SignedData" };
    const signedData = expect(contentInfo.children[1]!.children[0]!, TAG.SEQUENCE, "SignedData");
    const encap = signedData.children.find(
      (c) =>
        c.cls === 0 &&
        c.number === TAG.SEQUENCE &&
        c !== signedData.children[0] &&
        c.children[0]?.cls === 0 &&
        c.children[0]?.number === TAG.OID,
    );
    if (!encap || oidOf(encap.children[0]!) !== OID.tstInfo)
      return { ok: false, reason: "no TSTInfo content" };
    const eContent = octetsOf(encap.children[1]!.children[0]!);
    const tst = expect(parseDer(eContent), TAG.SEQUENCE, "TSTInfo");
    const policy = oidOf(tst.children[1]!);
    const imprintNode = tst.children[2]!;
    const imprintAlg = oidOf(imprintNode.children[0]!.children[0]!);
    const imprint = hex(octetsOf(imprintNode.children[1]!));
    const serial = integerHexOf(tst.children[3]!);
    const time = timeOf(tst.children[4]!);
    let nonce: string | undefined;
    for (const c of tst.children.slice(5))
      if (c.cls === 0 && c.number === TAG.INTEGER) nonce = integerHexOf(c);
    const partial = { time, imprint, policy, serial, ...(nonce ? { nonce } : {}) };
    if (imprintAlg !== OID.sha256)
      return { ok: false, reason: `imprint algorithm ${imprintAlg} is not SHA-256`, ...partial };
    if (imprint !== digestHex.toLowerCase())
      return { ok: false, reason: "imprint does not match the digest", ...partial };

    const certsNode = contextChild(signedData, 0);
    const certs = (certsNode?.children ?? [])
      .filter((c) => c.cls === 0 && c.number === TAG.SEQUENCE)
      .map(parseCertificate);
    const signerInfos = signedData.children.find(
      (c) => c.cls === 0 && c.number === TAG.SET && c !== signedData.children[1],
    );
    const signerInfo = signerInfos?.children[0];
    if (!signerInfo) return { ok: false, reason: "no SignerInfo", ...partial };
    const [, sid, digestAlgNode] = signerInfo.children;
    const signedAttrs = contextChild(signerInfo, 0);
    const sigAlgNode = signerInfo.children.find(
      (c, i) => i > 2 && c.cls === 0 && c.number === TAG.SEQUENCE,
    );
    const signatureNode = signerInfo.children.find(
      (c) => c.cls === 0 && c.number === TAG.OCTET_STRING,
    );
    if (!signedAttrs || !sigAlgNode || !signatureNode)
      return {
        ok: false,
        reason: "SignerInfo is missing signed attributes or a signature",
        ...partial,
      };
    const digestHash = HASH_BY_OID[oidOf(digestAlgNode!.children[0]!)];
    if (!digestHash)
      return {
        ok: false,
        reason: `unsupported digest algorithm ${oidOf(digestAlgNode!.children[0]!)}`,
        ...partial,
      };

    // The signer certificate: by issuer and serial, or by subject key identifier.
    let cert: Certificate | undefined;
    if (sid!.cls === 0 && sid!.number === TAG.SEQUENCE) {
      const issuer = sid!.children[0]!.bytes;
      const serialHex = integerHexOf(sid!.children[1]!);
      cert = certs.find((c) => c.serial === serialHex && bytesEqual(c.issuer, issuer));
    } else if (sid!.cls === 2 && sid!.number === 0) {
      const skid = hex(sid!.content);
      cert = certs.find((c) => c.subjectKeyId === skid);
    }
    if (!cert)
      return { ok: false, reason: "the signer certificate is not in the token", ...partial };
    const fingerprint = hex(new Uint8Array(await subtle().digest("SHA-256", buf(cert.node.bytes))));

    // messageDigest attribute must equal the hash of the encapsulated content.
    const expectedDigest = hex(new Uint8Array(await subtle().digest(digestHash, buf(eContent))));
    let messageDigest: string | undefined;
    for (const attr of signedAttrs.children)
      if (oidOf(attr.children[0]!) === OID.messageDigest)
        messageDigest = hex(octetsOf(attr.children[1]!.children[0]!));
    if (messageDigest !== expectedDigest)
      return {
        ok: false,
        reason: "messageDigest attribute does not match the content",
        ...partial,
      };

    // The signature covers the signed attributes re-tagged as a SET.
    const signedBytes = new Uint8Array(signedAttrs.bytes);
    signedBytes[0] = 0x31;
    const { hash, ec } = hashForSignature(oidOf(sigAlgNode.children[0]!), digestHash);
    const { key, algorithm, ecBytes } = await importSpki(cert.spki, hash);
    if (ec !== (ecBytes !== undefined))
      return {
        ok: false,
        reason: "signature algorithm does not match the certificate's key",
        ...partial,
      };
    const signature = ec ? ecdsaRaw(octetsOf(signatureNode), ecBytes!) : octetsOf(signatureNode);
    const good = await subtle().verify(
      ec ? { name: "ECDSA", hash } : { name: "RSASSA-PKCS1-v1_5" },
      key,
      buf(signature),
      signedBytes,
    );
    const signer = { subject: cert.subject, fingerprint, algorithm };
    if (!good)
      return {
        ok: false,
        reason: "signature does not verify against the signer certificate",
        ...partial,
        signer,
      };
    return { ok: true, ...partial, signer };
  } catch (err) {
    return { ok: false, reason: `malformed token: ${(err as Error).message}` };
  }
}

export interface Rfc3161Options {
  fetch?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> },
  ) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  timeoutMs?: number;
}

/** POST a request to an authority and return the granted token. */
export async function requestTimeStamp(
  url: string,
  digestHex: string,
  opts: Rfc3161Options = {},
): Promise<Uint8Array> {
  const body = buf(buildTimeStampReq(digestHex));
  const f =
    opts.fetch ??
    ((u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) }));
  const res = await f(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/timestamp-query",
      Accept: "application/timestamp-reply",
    },
    body,
  });
  if (!res.ok) throw new Error(`POST ${url}: ${res.status}`);
  const resp = parseTimeStampResp(new Uint8Array(await res.arrayBuffer()));
  if (resp.status > 1 || !resp.token)
    throw new Error(
      `${url} did not grant a token: status ${resp.status}${resp.statusText ? ` (${resp.statusText})` : ""}`,
    );
  return resp.token;
}
