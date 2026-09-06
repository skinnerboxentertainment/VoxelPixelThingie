# ADR 0006: Persistence is files first, and the store is anyone's

Date: 2026-09-06. Status: proposed.

## Context

ADR 0005 made the bit a spime: a stable id and an append-only history,
with rendering as one expression of it. The history lived in memory. A
spime's data trail must leave the process, survive the renderer, and come
back the same. Two further needs were raised: a bit should carry its own
free-form record, and a scene should be able to sit on a distributed store
that costs nothing to reach.

The choices were a database (SQLite or a document store), a single scene
file, a CRDT document, or plain files in a folder.

## Decision

**A bit owns a passport**, a JSON object of any shape, replaced whole by a
`passport` event, JSON-serializable, unread by the render path. No schema.
The model does not cap its size; sinks do.

**Events name where, who, and why.** Every stamped event carries the
container's id as `frame`. A container's wrangler context stamps optional
`actor` and `cause`. Ids default to UUID v7 for bits and containers.

**Persistence is two plain files per bit** in a folder per scene:
`passport.json`, the current state at a sequence number, and
`events.jsonl`, the history, one event per line, appended. A
`manifest.json` names the scene and may carry per-file hashes. The ledger
is written first and is the truth; the passport is a cache of it. A
truncated last line is discarded on read.

**The store is not the model's concern.** The layout is files, so it lives
on a local folder, the browser's origin private file system, a git
repository, IPFS, Hypercore, or a synced folder, without change. Reference
sinks: `FileSink`, `OpfsSink`, `MemorySink`.

**Compaction keeps a tail** of recent events per bit and may drop events at
or below the passport's sequence, link events first, and marks the
manifest when it has.

**The oracle is the round trip.** Export, import, and compare every bit's
ids, positions, emissions, passports, links, and render flags. Equality
across any store is what "the same bit" means.

## Consequences

- Any tool that can read a text file can read a bit's life. No driver, no
  schema migration, no server.
- Git gives history and integrity for free today; IPFS gives content
  addressing when it is wanted. Choosing between them is a deployment
  decision, not a model decision.
- Whole-passport replacement is simple and replayable but wasteful for
  large, frequently edited passports. Open question 5 in SPEC.md tracks a
  patch event.
- Files per bit means many small files. A 32³ scene is 32,768 folders.
  That is acceptable on local disks and git; it is slow on some object
  stores and on IPFS without a directory sharding strategy.
  Amended 2026-09-06: the packed single-file variant now exists
  (`vpb-scene-pack/1`, SPEC.md §10.8) because the first IPFS pinning free
  tier counted files, 500 allowed against 1,025 in a scene. It is a
  lossless container for the same layout, not a second format.
- Nothing in `evaluate` changes. Persistence is entirely sinks.

## Alternatives considered

- **SQLite.** Excellent locally; a binary blob on every distributed store,
  which defeats "any store" and hides history from plain tools.
- **One JSON file per scene.** Simple, but every event rewrites the whole
  file, and two wranglers cannot touch different bits without conflicts.
- **A CRDT document (Automerge, Yjs).** Solves multi-wrangler merging,
  which is not a current need, at the cost of a binary format and a large
  dependency. The `seq` field keeps the door open.
- **A database server.** Not free, not distributed by default, and a server
  is exactly what a spime should not need to exist.
