# ADR 0013: Seals are witnessed, and keys rotate by chain

Date: 2026-09-06. Status: accepted.

## Context

A signed seal (Phase 11) proves that the container's key signed these
hashes, for as long as the key's DID document is served and the key is
the container's. `did:web` has no history and no rotation; take the page
down or replace the key and every old seal becomes "unresolved" forever.
A record meant to outlive its hosts needs two things the signature alone
cannot give: a time that does not depend on us, and a way for a key to
hand over to its successor without orphaning what it signed.

The field's answer to the first is trusted time-stamping: RFC 3161 tokens,
which every code-signing toolchain uses and which free public authorities
issue with no account; transparency-log inclusion proofs are the newer
cousin. The answer to the second, in the DID methods that have it, is a
statement signed by the old key naming the new one.

## Decision

- **A `Witness` contract, one call.** `attest(digest)` returns a proof; a
  verifier checks a proof against a digest and reports the time, the
  witness, and whether that witness is in the caller's trust list. The
  digest is the SHA-256 of the seal's signature value, so a witness binds
  the signature, which binds the hashes, which bind the files.
- **The reference is a notary.** Any Ed25519 key signing `{ digest, time }`.
  It runs in process, needs nobody, and its public key travels in the
  proof so the proof checks without a trust list. A notary proves what a
  notary is worth: exactly as much as you trust that key.
- **The public backend is RFC 3161.** `src/rfc3161.ts` builds a request
  (byte-equal to `openssl ts -query`), reads the response, and verifies
  the token's CMS signature with WebCrypto against the signer certificate
  the token carries, for RSA PKCS#1 v1.5 and ECDSA on the NIST curves.
  Tokens from two authorities, one RSA and one ECDSA, are recorded under
  `tests/fixtures/rfc3161/` so verification runs offline. The DER reader
  handles the shapes those tokens contain and refuses the rest.
- **Anchoring is the caller's list.** Verification proves the certificate
  in the token signed it at `genTime`; it does not walk a chain to a root.
  A trust list of certificate fingerprints (or notary keys) makes a
  witness "anchored"; without one the verdict says "unanchored", which is
  the truth: a witness you did not name is nobody in particular.
- **Rotation is a signed chain in the DID document.** `rotations` is a
  plain-JSON extension listing `{ from, fromKey, to, toKey, retired }`
  statements, each signed by the key being retired. A seal by a key the
  document no longer asserts with verifies through the chain from that
  key to a current one. If a witness places the seal after `retired`, the
  verdict is `retired` and the seal is not accepted; without a witness the
  seal verifies and the report says the time is unknown.
- **Unresolved is still not a failure.** With the DID's host gone, the
  hashes stand, the witnesses are checked, and the report names the time
  and the witness. That is the phase's oracle.

## Consequences

- SPEC v0.9 §10.3 gains `witness` on the signature and `rotations` on the
  DID document. Existing seals and documents are unchanged and verify as
  before.
- Whether the reference scene is witnessed by a public authority is
  Oscar's decision (PLAN-4.md): such a token is a permanent public record
  that the digest existed at that time. The scripts accept either kind;
  the journal records which was used.
- The DER and CMS code is deliberately narrow. A token using RSA-PSS, a
  SHA-1 imprint, or a certificate found only by a subject key identifier
  the token does not carry is refused by name, not guessed at.
- Time from a witness is only as good as the witness. The report carries
  every verdict separately so a reader can weigh them; `witnessedAt` is
  the earliest time a holding proof asserts.
