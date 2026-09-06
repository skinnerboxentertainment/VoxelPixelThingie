# Releasing

A release is something anyone can rebuild from its source and get the
same bytes, see the list of everything inside it, and check that the
copy they hold is the one we made. PLAN-4.md Phase 22, ADR 0016.

## Build

```
npm run release:build
```

Runs the demo and reader builds with `SOURCE_DATE_EPOCH` pinned to the
commit's time and writes `release/release.json`: the version, the commit,
the epoch, every file under `dist/` and `dist-reader/` with its SHA-256,
and one digest over that list. `release/sbom.spdx.json` (SPDX 2.3, from
`npm sbom`, the whole dependency tree, dev included, because that is the
set npm states exactly) sits beside it; its own timestamp
and namespace keep it out of the digest.

Two clean checkouts of the same commit give the same digest. CI's
`release-check` job builds it too and uploads its `release.json` as an
artifact, so the two can be compared.

## Attest

```
npm run release:attest -- --key ~/.config/vpb/<container>.jwk --did did:web:... \
  --witness notary:~/.config/vpb/notary-reference.jwk
```

Signs the digest with the container key and, with `--witness`, attaches
a notary's or an RFC 3161 authority's proof of the time, writing
`release/release.sig.json`. Whether a release is also attested on a public
transparency log (in-toto/SLSA provenance) is Oscar's decision; the
verifier reports provenance as "not checked" until it is made.

## Verify

```
npm run release:verify -- --did-doc <did.json or URL>
```

Recomputes every hash, the digest, the signature against the DID document
(resolved over the network without `--did-doc`), and each witness, and
prints one line per source. A changed file is named; an unresolved DID is
reported, not failed; a forged signature or a file that differs fails.

## Cutting a version

Versions are cut by release-please from Conventional Commits on `main`.
0.4.0 is held until first light on the physical bit (PLAN-2.md Phase 10).
Attach `release.json`, `sbom.spdx.json`, and `release.sig.json` to the
GitHub release when it is cut, and record both machines' digests in the
journal.
