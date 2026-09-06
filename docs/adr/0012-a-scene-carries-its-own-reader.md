# ADR 0012: A scene carries its own reader

Date: 2026-09-06. Status: accepted.

## Context

A scene could be verified from four kinds of store (§10.9) and signed by
its container's key (ADR 0008, Phase 11), but opening it took this
repository, Node, and `npm ci`, and the passport page needed the demo
build served. A record meant to outlive its makers cannot depend on
their toolchain being installed. PUNCHLIST.md item 1 asked for one
dependency-free file that opens a pack and shows any bit's passport and
history, with the SPEC text travelling inside.

## Decision

- **One HTML file, nothing else.** `demo/reader/` is a page with no
  renderer and no runtime dependency. `vite.reader.config.ts` inlines its
  script and style into one file; the plugin that does so is a build-time
  dependency only.
- **The scene, the SPEC, and the DID document ride inside.**
  `scripts/reader-scene.ts` injects a `vpb-scene-pack/1` pack, the SPEC
  text, and the container's DID document as `application/json` script
  blocks. Any `<`, U+2028, and U+2029 in the JSON is escaped, so a
  passport containing a closing script tag cannot break out. The pack
  format does not change; every existing pack opens in the reader.
- **Verification is the repository's own code.** The page imports
  `src/verify.ts`; it does not carry a second implementation. The
  signature is checked by resolving the DID when the network allows, and
  against the embedded document when it does not, and the page says which
  of the two it did. "Verified against the embedded document" is a weaker
  claim than "resolved", and the wording keeps them apart.
- **Accessible from the first commit.** The reader ships with an axe
  audit and a keyboard-only path in its oracle, the standard PLAN-4.md
  sets for every new page.

## Consequences

- Publishing a scene now means publishing its reader beside its pack. The
  reference scene's reader lives in the scenes repository next to
  `reference-8.pack.json`.
- The reader is a wrapper, not a store. A file edited by hand fails its
  own seal; the test proves one changed byte names the bit.
- The embedded DID document is only as trustworthy as the file it came
  in. A witness timestamp (Phase 18) is what makes the file's own word
  about its signature stand after the DID's host is gone; until then the
  reader's offline verdict is "the signature matches the key this file
  carries", which the page states as such.
- The file is about three megabytes for the reference scene, almost all
  of it ledgers. Compaction (§10.7) is the lever if that grows.
