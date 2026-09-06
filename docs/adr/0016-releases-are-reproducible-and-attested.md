# ADR 0016: Releases are reproducible and attested

Date: 2026-09-06. Status: accepted.

## Context

Releases were release-please tags with a changelog. Nothing said what
bytes a release was, and nothing let a stranger check that a copy was
ours. PUNCHLIST.md item 6 asked for a pinned reproducible build, a bill
of materials, and release artifacts signed into a public log.

Two facts made this cheap: the demo build was already byte-identical
across runs (probed 2026-09-06), and `npm sbom` emits SPDX 2.3 from the
lockfile with no extra tool. The field's answer to "signed into a public
log" is in-toto/SLSA provenance recorded on Sigstore's public-good
transparency log, which is what npm and most open source use; it is also
a permanent public record, which PLAN-4.md lists as Oscar's decision.

## Decision

- **A release manifest with one digest.** `release.json` names the
  version, the commit, the `SOURCE_DATE_EPOCH` the build ran under (the
  commit's time), and every built file with its SHA-256 and size, in
  sorted order under named trees (`dist`, `dist-reader`). The digest is
  SHA-256 over the canonical text of all of that. Rebuild the commit
  anywhere and the digest is the same, or the build is not reproducible
  and the comparison says so.
- **The SBOM sits beside the digest, not inside it.** `npm sbom` stamps a
  creation time and a random namespace, so it cannot be reproduced byte
  for byte; a test proves its package list equals the lockfile's
  instead. It is the whole tree, dev dependencies included: npm's
  `--omit dev` projection also drops production packages that a dev
  dependency shares (probed 2026-09-06), so the exact set is the full one.
- **The attestation is the container key plus witnesses.** The same key
  that signs scene seals signs the release digest; the same `Witness`
  contract (ADR 0013) attests the signature's time. Verification is the
  same code path as a seal: DID document, rotation chain, `retired`.
  This needs no account.
- **Provenance is a second backend, behind the decision.** A workflow
  step for in-toto/SLSA provenance on the host's log is the obvious
  addition once Oscar decides; the verifier reports provenance as "not
  checked" until then rather than pretending.
- **CI builds it too.** The `release-check` job runs the same build on a
  Linux runner and uploads its manifest, so a Windows build and a Linux
  build of the same commit can be compared. Two machines agreeing is the
  oracle; one machine agreeing with itself is only the first half.

## Consequences

- `RELEASING.md` is the procedure. 0.4.0 stays held; everything here
  runs against a pre-release build.
- A dependency bump that breaks reproducibility shows up as two digests
  that differ, in CI, before it ships.
- The manifest names the commit, not the working tree; a dirty tree is
  reported at build time and the manifest is still made, because the
  comparison against a clean checkout is what catches it.
- Cross-platform reproducibility (Windows against Linux) is a claim the
  Phase 22 journal makes only with both digests written down.
