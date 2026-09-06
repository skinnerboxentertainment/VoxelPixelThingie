# VoxelPixelThingie — Core Model Specification

Status: Draft v0.9
Date: 2026-09-06
Author: Oscar

## 1. Purpose

This document defines the atomic data model for VoxelPixelThingie: what a
VoxelPixelBit is, what it contains, how its parts are addressed, and how
neighboring bits relate to each other. It records decisions already made and
lists questions still open. It does not cover the renderer itself, persistence, or input, but it does
define the bit's responsibility toward the renderer (§8).

## 2. Vocabulary

| Term | Meaning |
|------|---------|
| VoxelPixelBit (bit, VPB) | The atomic unit. A unit cube occupying one grid cell. Nothing is smaller. |
| Node | Any addressable, emitting element owned by a bit: a face, an edge, or a vertex. |
| Face | One of the 6 square sides of a bit. Emits over an area. |
| Edge | One of the 12 line segments where two faces of a bit meet. Emits along a line. |
| Vertex | One of the 8 corner points of a bit. Emits from a point. |
| Link | An explicit record that two nodes belonging to different bits are in contact. |
| Voxel cube (cube) | A grid array of bits, for example 8×8×8. |
| Network | The graph formed by all nodes and all links in a cube. |
| Container | The owner of a set of bits. Mints ids, links neighbors, supplies the event sink. `FlatGrid` is the default; `Grid` is the reference both are measured against (ADR 0007). |
| Event | One recorded change to a bit. See §9. |
| Spime | Sterling's term for an object whose identity and full history are knowable through its data. The VPB is designed as one (ADR 0005). |
| Passport | A bit's own free-form JSON record, carried with its identity (§9.5). |
| Wrangler | Whoever or whatever changes bits: a person, a tool, a replay. Named on events by the container's wrangler context (§9.6). |
| Scene | A container's on-disk form: a folder holding a manifest and one folder per bit (§10). |

## 3. The VoxelPixelBit

A bit is a cube. It has:

- An identity: an immutable, opaque `id` minted by its container at
  creation. Two bits with the same id are the same bit. See §9.
- A position in the grid: integer `(x, y, z)`. Position is a property, not
  the identity; a bit may move.
- A presence state: present or absent. An absent bit occupies no cell and
  has no links.
- A passport: a free-form JSON object owned by the bit (§9.5). Default `{}`.
- 26 privately owned nodes: 6 faces, 12 edges, 8 vertices.
- Per-bit state, at minimum a color. Further fields are open (see §8).

A bit counts as 27 addressable units: itself plus its 26 nodes.

### 3.1 Node counts

| Node type | Count per bit | Emission geometry |
|-----------|---------------|-------------------|
| Face | 6 | area |
| Edge | 12 | line |
| Vertex | 8 | point |
| Total | 26 | |

### 3.2 Node contents

Every node, regardless of type, can be controlled to emit. An emission is a
fixed struct of three optional fields; a field left undefined means "not
emitting that."

| Field | Type | Meaning |
|-------|------|---------|
| `color` | number, 24-bit RGB | what the node shows |
| `light` | number, intensity | how strongly it glows |
| `data` | any | what it says to the network |

A node with all three undefined is silent (§8.2).

## 4. Ownership model: private nodes plus explicit links

Decision: the hybrid model.

### 4.1 Private nodes

Every node belongs to exactly one bit. When two bits are adjacent, each keeps
its own face on the shared boundary. The two faces are distinct nodes with
distinct state. The same holds for edges and vertices at the boundary.

Consequences:

- A bit is self-contained. It can be created, destroyed, moved, or serialized
  without altering any other bit's nodes.
- Opposing emission across a boundary is legal. One face may be red while the
  face pressed against it is blue or dark.
- Node addressing needs no neighbor lookup.
- Hidden nodes (those facing an adjacent bit) are still real nodes with real
  state. Whether they render is a rendering decision, not a model one.
- Bits update independently. No shared state means no write contention.

### 4.2 Explicit links

Adjacency is recorded as links between nodes of different bits. A link states
that two nodes are in contact. Links are the network's edges in graph terms.

Link fan-out by node type:

| Node type | Bits that can meet there | Max links per node |
|-----------|--------------------------|--------------------|
| Face | 2 | 1 |
| Edge | 4 | 3 |
| Vertex | 8 | 7 |

Links carry no state of their own in v0.1. Adding link state (signal
strength, blocked flag, directionality) is anticipated and permitted by this
model.

### 4.3 Why hybrid

Shared nodes make a true lattice and are smaller, but cannot express opposing
emission and make bit removal reassign co-owned nodes. Private nodes keep bits
portable and independent but lose adjacency. The hybrid keeps both behaviors
at the cost of the most memory. The trade was accepted deliberately.

## 5. Addressing

### 5.1 Grains

Nodes are addressable at three grains:

1. Individually: one node.
2. Collectively: an arbitrary set of nodes.
3. As an array pattern: a rule that selects nodes, for example "all +Y faces
   in layer 3" or "every vertex on the outer shell."

### 5.2 Node address

A node is identified by `(bit, slot)` where `bit` is the bit's identity and
`slot` is a local index in `0..25`.

| Slot range | Node type | Count |
|------------|-----------|-------|
| 0–5 | face | 6 |
| 6–17 | edge | 12 |
| 18–25 | vertex | 8 |

For a bit on a dense grid, `bit` can be the linear cell index
`x + y·W + z·W·H`, giving a flat node index of `bitIndex · 26 + slot`.

### 5.3 Sign convention

Every ordering below follows one rule. Each axis of a bit has a negative side
and a positive side. Negative encodes as `0`, positive as `1`. Axes are
ordered `X, Y, Z`, and when several axes are packed into one number, X is the
least significant bit.

### 5.4 Face slots (0–5)

`slot = 2 · axis + sign`, where `axis` is X=0, Y=1, Z=2 and `sign` is 0 for
negative, 1 for positive.

| Slot | Face |
|------|------|
| 0 | −X |
| 1 | +X |
| 2 | −Y |
| 3 | +Y |
| 4 | −Z |
| 5 | +Z |

### 5.5 Edge slots (6–17)

An edge runs parallel to one axis and sits at a fixed sign on each of the
other two. Edges are grouped by the axis they run along, and within a group
by the signs of the remaining two axes, lower axis first as the low bit.

`slot = 6 + 4 · axis + (signA + 2 · signB)`, where `axis` is the axis the
edge runs along and `(A, B)` are the other two axes in `X, Y, Z` order.

| Slot | Runs along | Position | Endpoints (vertex slots) |
|------|------------|----------|--------------------------|
| 6 | X | −Y −Z | 18, 19 |
| 7 | X | +Y −Z | 20, 21 |
| 8 | X | −Y +Z | 22, 23 |
| 9 | X | +Y +Z | 24, 25 |
| 10 | Y | −X −Z | 18, 20 |
| 11 | Y | +X −Z | 19, 21 |
| 12 | Y | −X +Z | 22, 24 |
| 13 | Y | +X +Z | 23, 25 |
| 14 | Z | −X −Y | 18, 22 |
| 15 | Z | +X −Y | 19, 23 |
| 16 | Z | −X +Y | 20, 24 |
| 17 | Z | +X +Y | 21, 25 |

### 5.6 Vertex slots (18–25)

`slot = 18 + (signX + 2 · signY + 4 · signZ)`.

| Slot | Vertex |
|------|--------|
| 18 | −X −Y −Z |
| 19 | +X −Y −Z |
| 20 | −X +Y −Z |
| 21 | +X +Y −Z |
| 22 | −X −Y +Z |
| 23 | +X −Y +Z |
| 24 | −X +Y +Z |
| 25 | +X +Y +Z |

### 5.7 Intra-bit incidence

Fixed by geometry, listed here so implementations agree.

| Face | Edges | Vertices |
|------|-------|----------|
| 0 (−X) | 10, 12, 14, 16 | 18, 20, 22, 24 |
| 1 (+X) | 11, 13, 15, 17 | 19, 21, 23, 25 |
| 2 (−Y) | 6, 8, 14, 15 | 18, 19, 22, 23 |
| 3 (+Y) | 7, 9, 16, 17 | 20, 21, 24, 25 |
| 4 (−Z) | 6, 7, 10, 11 | 18, 19, 20, 21 |
| 5 (+Z) | 8, 9, 12, 13 | 22, 23, 24, 25 |

## 6. The cube as a network

A voxel cube is a graph:

- Vertices of the graph: every node of every present bit.
- Edges of the graph: every link.
- Each bit is a subgraph of 26 nodes. Intra-bit structure (which face borders
  which edge, which edge ends at which vertex) is fixed by geometry and need
  not be stored.

Size, dense 8×8×8 for reference:

| Quantity | Count |
|----------|-------|
| Bits | 512 |
| Nodes | 13,312 |
| Faces | 3,072 |
| Visible faces on a solid cube | 384 |

## 7. Derivation of links

On an axis-aligned grid, links are fully determined by bit positions.

Partner rule: take a node and a neighbor bit offset by `(dx, dy, dz)` with
each component in `{−1, 0, +1}`. The node links to the neighbor's node of the
same type whose sign is flipped on every axis where the offset is nonzero,
and unchanged on every axis where it is zero. The node's own sign must match
the offset direction on each nonzero axis, otherwise no link exists.

Examples:

- Face `+X` (slot 1) at offset `(+1,0,0)` links to the neighbor's `−X`
  (slot 0).
- Edge along X at `+Y +Z` (slot 9) links to three neighbors: offset
  `(0,+1,0)` slot 8 (`−Y +Z`), offset `(0,0,+1)` slot 7 (`+Y −Z`), and offset
  `(0,+1,+1)` slot 6 (`−Y −Z`).
- Vertex `+X +Y +Z` (slot 25) links to seven neighbors, one for each nonzero
  offset with all components in `{0,+1}`, at the vertex with the
  corresponding bits flipped.

Therefore the link table may be computed on demand rather than stored, as
long as all bits sit on the grid. Storing links becomes necessary when either
of the following holds:

- Bits may sit off-grid or float apart.
- Links carry their own state.

v0.1 permits either implementation. The model is the same.

A container that derives links from positions may omit `linked` and
`unlinked` events from its log (v0.5). Replay never applies them, and a
compactor drops them first. Where they are recorded they remain
informational: the derived link is the truth on a grid.

## 8. Self-optimizing render cycle

A VPB is responsible for its own render cost. It does not wait for a global
culling pass. Each bit continuously tests its own components and disables
whatever it can prove will not contribute to the frame.

### 8.1 Principle

Every node carries a render-enabled flag, and the bit as a whole carries a
render-cycle flag. Both default to on. The bit's job is to turn them off
whenever it can and turn them back on the moment the reason lapses.

Example: an array of VPBs forming a wall in a 3D scene. As the camera moves
around the wall, each bit on its own decides which of its 26 nodes are worth
drawing this frame, and bits that cannot be seen at all drop out of the
render cycle entirely, without the scene telling them to.

### 8.2 Tests a bit runs on itself

Listed from cheapest to most expensive. A bit stops at the first test that
disables the whole cycle.

| Test | Scope | Disables when |
|------|-------|---------------|
| Presence | bit | The bit is absent. |
| Silence | node | The node emits nothing (no color, no light, no data bound for the screen). |
| Occlusion by link | node | The node has a link. A linked face, edge, or vertex is pressed against a neighbor and cannot be seen. |
| Full enclosure | bit | All 6 faces are linked. The bit is interior and leaves the render cycle. |
| Back-facing | node | The cosine between the node's outward direction and the direction to the camera is below −ε, with ε = 1e-4. A node exactly edge-on stays enabled; the renderer's own back-face culling makes the final cut. For an orthographic view the camera supplies a direction instead of a point, the test is against that direction, and it is exclusive: an edge-on node has no projected area and does not render. Straight down an axis this leaves exactly 9 of 26 nodes. |
| Frustum | bit | The bit's bounding cube is entirely outside the view frustum. |
| Screen coverage | bit | The bit projects to less than one pixel and is not the nearest such bit. |

The link table makes the occlusion tests free. A node's link count is already
known; no geometry query is needed.

### 8.3 When tests re-run

Tests are event-driven, not per-frame by default. A bit re-evaluates when:

- Its own state changes (presence, emission on any node).
- A link is added or removed on any of its nodes (a neighbor appeared or
  vanished).
- The camera moves, for the camera-dependent tests only (back-facing,
  frustum, screen coverage).

Link-dependent results are cached until a link changes. Camera-dependent
results are cached until the camera changes. A bit with all six faces linked
never runs a camera test at all.

### 8.4 Emission versus rendering

Disabling render does not disable emission. A hidden face still holds its
state and still emits into the network through its link. Render-off means
"do not draw," not "do not exist." This preserves open question 5 in §9.

### 8.5 Scale note

Per-bit self-testing is cheap for hundreds or thousands of bits. Beyond that,
the test itself becomes the cost, and bits will need to be grouped so that a
parent can answer frustum and coverage questions for many bits at once. This
is anticipated and not designed here. The principle stands either way: the
decision belongs to the bit, and a parent only short-circuits it.

### 8.6 Physical expression (informative)

A physical bit, a cube with LEDs on its faces, edges, and corners, shows
emissions, not the culled render list: it is seen from every side, so the
self-test of §8.2 does not apply to it. An absent bit is dark. The map from
slots to LEDs is data the bit carries in its passport (§9.5); the wire
protocol and the driver are outside the model (ADR 0009).

## 9. Identity and history

Adopted from ADR 0005: the VPB is a spime. Its data trail is its primary
existence; any rendering, including a physical one, is one expression of it.

### 9.1 Identity

Every bit carries an immutable `id`. The container mints it; the bit never
mints its own. Ids are opaque strings with no meaning to the model. The
grid cell is a mutable property. Serialization, movement, and re-expression
in another renderer preserve the id.

Default minting is UUID version 7 (RFC 9562): globally unique without
coordination, and sortable by minting time, so a scene's bits list in the
order they were made. Containers mint their own id the same way. Tests may
inject a readable counter through `mintId`. An id is never reused, not even
after `destroyed`.

### 9.2 Events

Every change to a bit is an event. Events are appended, never edited, to a
log keyed by bit id. Each carries a sequence number and a timestamp, both
supplied by the container.

| Event | Payload |
|-------|---------|
| `created` | position, color, initial emission |
| `presence` | present or absent |
| `emitted` | slot, emission |
| `linked` | neighbor id, slot, partner slot, offset |
| `unlinked` | neighbor id, slot |
| `moved` | from, to |
| `annotated` | free-form key and value |
| `passport` | the bit's complete new passport (§9.5) |
| `destroyed` | none; the bit leaves its container |

Every stamped event carries, beside its payload:

| Field | Meaning | Supplied by |
|-------|---------|-------------|
| `bit` | the bit's id | container |
| `seq` | monotonic within the container | container |
| `time` | milliseconds since the epoch | container clock |
| `frame` | the container's id: where this happened | container |
| `actor` | who or what made the change, optional | wrangler context (§9.6) |
| `cause` | why, optional; a short verb phrase | wrangler context (§9.6) |

The bit's fields are a projection of its log. Folding a bit's events in
order from `created` reproduces its current state, passport included.

### 9.3 Where the log lives

Bits emit events to a sink supplied by the container, which stamps each
with the bit id, sequence, and time. The default sink discards. Presence
toggles go through the container so that a returning bit is relinked; the
container emits `created` and `destroyed`, the bit emits the rest. Recording, retention, compaction, and replay are sink concerns
and are not specified in v0.3.

### 9.4 What the log does not touch

The self-test in §8 reads current state only. No part of the render path
consults the log. `Emission.data` is what a node says to the network;
provenance is the log, not `data`.

### 9.5 Passport

Each bit owns one passport: a JSON object of any shape, default `{}`. It is
the bit's own record, the thing a wrangler would read to learn what this
bit is, and it travels with the id through every container, export, and
renderer.

- The model imposes no schema. Keys and values are the wrangler's business.
- The value must be JSON-serializable. Functions, cycles, and non-finite
  numbers are rejected at `setPassport`.
- Replacement is whole: `setPassport(obj)` emits one `passport` event
  carrying the complete new object. Partial patches are not in v0.4; a
  wrangler that wants them reads, merges, and sets.
- Sinks may enforce a size limit and must say so; the model does not. The
  reference file sink refuses passports over 256 KiB serialized.
- The passport is distinct from `Emission.data` on a node (what a node says
  to neighbors) and from `annotated` events (notes in the history that do
  not change state).
- Nothing in the render path reads the passport.
- One key is reserved by convention: `ledMap`, a `vpb-led-map/1` object
  (strip length, one LED range per slot) that a physical bit carries so a
  driver can light it without other configuration (§8.6, ADR 0009). A
  passport without it is driven with the default map.

### 9.6 Wrangler context

A container holds a current wrangler context, `{ actor?, cause? }`, that
it stamps onto every event. It is set by whoever is about to change bits
and cleared or replaced when they are done:

```
grid.wrangle({ actor: "oscar", cause: "carve tunnel" }, () => { ... });
```

Inside the callback every event carries those two fields. Outside it they
are absent. Replay stamps `actor: "replay"` and copies the original
`cause`. Nested contexts replace, and restore on exit. The context is a
convenience for honest logs, not a security boundary.

### 9.7 Work

A bit can be asked for work, and the work becomes part of its history
(ADR 0010). Nothing is added to the event set: a job is three `annotated`
events under reserved keys sharing an `id`, and a reference sink refuses a
malformed one.

- `job:request`: `{ id, kind, params?, where? }`. What was asked and where
  the requester wanted it run.
- `job:result`: `{ id, ms, worker?, value? | cid?, bytes? }`. A small result
  inline as JSON; a large one stored by content id (a CIDv1, raw codec,
  SHA-256) with the id in the record. The passport limit of §9.5 applies to
  the record, not to what the id names.
- `job:audit`: `{ id, check, passed, detail? }`. The check in words a
  stranger can repeat, and whether it passed. A workload that throws is an
  audit that failed, not a job that vanished.
- `job:reward`, optional: `{ id, note? }`. Written only after an audit that
  passed. What a reward means is the wrangler's business.

The order is request, result, audit, reward. An actor that runs work
writes them under a wrangler context whose `actor` names it (§9.6), so
the ledger records who did the work as it records who carved a bit.
Nothing in the render path reads job records.

## 10. Persistence

A spime's data trail must be able to leave the process. This section fixes
the on-disk shapes so that any store that holds files can hold a scene.

### 10.1 Two shapes

| Shape | File | Contents | Written |
|-------|------|----------|---------|
| Passport | `passport.json` | the bit as it is now, plus its `seq` | rewritten after each event |
| Ledger | `events.jsonl` | every stamped event, one JSON object per line | appended, never rewritten except by compaction (§10.7) |

The render list is a third, renderer-facing shape and is not persisted.

### 10.2 Layout

```
<scene>/
  manifest.json
  bits/
    <bit id>/
      passport.json
      events.jsonl
```

One folder per bit, named by its id. The scene folder is the container's
on-disk form and is named by the wrangler; the container's id is inside
`manifest.json`, not in the folder name.

### 10.3 manifest.json

```json
{
  "format": "vpb-scene/1",
  "scene": "<container id>",
  "created": 1789000000000,
  "updated": 1789000123456,
  "bits": 485,
  "seq": 13842,
  "hashes": { "<bit id>": { "passport": "sha256:...", "events": "sha256:..." } }
}
```

`hashes` is optional. When present it lets an importer check integrity on
a store that does not address content by hash. `seq` is the container's
last stamped sequence number. `ids` lists every bit folder, so a store that
cannot list a directory (a URL prefix, for example) can still enumerate the
scene; sinks write it on every manifest update.

A sealed manifest may also carry `signature`: the container's `did:web`,
a key id, `alg` `EdDSA`, and a base64url Ed25519 signature over the
canonical text of the scene id, the sorted ids, and every hash. The
container's DID document, served where `did:web` says, holds the public
key. A reader that resolves the DID can tell the manifest was written by
the container's key and not rewritten since; a reader that cannot still
has the hashes, which stand on their own.

The signature may carry `witness`: proofs from third parties that the
SHA-256 of `signature.value` existed at a time. Two kinds: `vpb-notary/1`,
an Ed25519 key of anyone's signing `{ digest, time }` and carried with the
proof, and `rfc3161/1`, a time-stamp token from an RFC 3161 authority.
A reader checks every proof whether or not the DID resolves and reports
each one's time and whether the witness is in its trust list. A witness
proves "existed by", never "made by".

A container may rotate its key. The DID document then lists `rotations`:
statements `{ from, fromKey, to, toKey, retired }` each signed by the key
being retired. A signature by a key the document no longer asserts with
verifies through the chain from that key to a current one; if a witness
places the signature after `retired`, the reader reports `retired` and
does not accept it. ADR 0013.

### 10.4 passport.json

```json
{
  "format": "vpb-passport/1",
  "id": "0192f7a2-3b4c-7d5e-8f60-1a2b3c4d5e6f",
  "frame": "<container id>",
  "seq": 1234,
  "time": 1789000123456,
  "present": true,
  "position": [3, 3, 0],
  "color": 2058987,
  "emissions": [ { "color": 2058987, "light": 0.6 }, "…26 entries…" ],
  "passport": { "…the wrangler's blob…" }
}
```

`seq` is the last event applied to this bit. Links are not stored: within a
scene they are derived from positions (§7). Absent bits keep their file so
their history stays reachable.

### 10.5 events.jsonl

One stamped event per line, exactly the object of §9.2 serialized as JSON,
no wrapping array, newline-terminated. Lines are appended in `seq` order.
A reader that finds a truncated final line (a crash mid-write) discards it
and treats the file as ending at the previous line.

### 10.6 Write ordering

A file sink applies each event in this order:

1. Append the event line to `events.jsonl` and flush.
2. Rewrite `passport.json` by writing a temporary file and renaming it over
   the old one.
3. Update `manifest.json` the same way, at most once per batch.

So at every instant `passport.seq` is at most the last event's `seq`, and
an importer that finds `passport.seq` behind the ledger applies the tail.
The ledger is the truth; the passport is a cache of it.

### 10.7 Retention and compaction

This closes former open question 5.

- A passport is a snapshot at its `seq`. Events with `seq` at or below the
  passport's are derivable from it and may be dropped by compaction.
- Compaction keeps a configurable tail of the last `K` events per bit
  (default 64) so recent history stays readable without the passport.
- `linked` and `unlinked` events are derivable from the other events within
  a scene and are dropped first. This was verified for one carve sequence
  in Phase 1 and is not proven in general; a compaction that drops them
  records `"compacted": true` in the manifest so an importer knows the
  ledger is not complete.
- Compaction is a sink operation, run on demand, never inside `evaluate`.

### 10.8 Stores

The layout is plain files, so a scene lives on anything that holds files.
The model names no store. The reference sinks are:

| Sink | Where | Notes |
|------|-------|-------|
| `FileSink` | a folder, Node `fs` | the reference implementation of §10.6 |
| `OpfsSink` | the browser's origin private file system | same layout, no server, per-origin |
| `MemorySink` | an in-memory map of paths to strings | tests |
| `FetchStore` | a URL prefix, read-only | a mirror on a static host, a raw git URL, or an IPFS gateway; lists bits from `manifest.ids` |
| `PackedStore` | one JSON file holding every file's text, read-only | for stores that count or charge per file, or serve single objects; a sealed manifest verifies against a pack byte for byte |

A scene folder mirrored to a distributed store is still a scene. Git and
GitHub give append-only history and a fingerprint per file for free. IPFS
names each file by its content hash, so the hash of a passport is proof of
that passport. Hypercore is itself an append-only log and could carry
`events.jsonl` line for line. Syncthing mirrors a folder between devices.
None of these need the model to change; they need the folder.

With a signed seal (§10.3) the test has a stranger's form: given only a
content address for the pack and the container's DID, verify the
signature against the DID document, then the hashes, then the digest.
Nothing of the publisher's needs to be running.

**Packed variant.** `vpb-scene-pack/1` is the folder as one JSON object:
the manifest plus each bit's passport and ledger as raw text. `packScene`
and `unpackScene` convert without loss, so the seal holds on both forms.
Use it where files are counted (an IPFS pinning free tier allows 500 and a
scene has 1,025) or where a store serves single objects.

### 10.9 The spime test

A scene exported through a sink and imported through `openScene` must
reproduce every bit: same ids, same positions, same emissions, same
passports, same links, and the same render flags after `evaluate` with the
same camera. That equality, across a round trip through any store, is what
"the same bit" means. It is the oracle for every persistence ticket.

## 11. Open questions

1. What fields does a bit hold beyond position, presence, and color?
2. Do links carry state in v0.2, and if so which fields?
3. Rendering: real 3D or an isometric 2D projection of pixels?
4. Does a hidden face (one with a link) emit into the network only, or can it
   also affect rendering, for example as light bleed?
5. Should large passports get a patch event (RFC 6902) instead of whole
   replacement, and at what size?
6. Should `manifest.json` hashes be mandatory on stores without content
   addressing, and who verifies them on import?

## 12. Decisions log

| Date | Decision |
|------|----------|
| 2026-09-05 | VoxelPixelBit is the atomic unit. |
| 2026-09-05 | Every face, edge, and vertex is individually, collectively, and array-addressable, and can emit. |
| 2026-09-05 | Nodes are private to their bit. Adjacency is recorded as explicit links (hybrid model). |
| 2026-09-05 | Slot ordering fixed for faces, edges, and vertices under one sign convention (§5.3–5.6). Face order changed from `+X,−X,…` to `−X,+X,…` for consistency. |
| 2026-09-05 | A VPB self-tests its components and disables its own render cycle or individual nodes to save processing. Culling is the bit's responsibility, not a global pass (§8). |
| 2026-09-05 | The VPB is a spime: stable container-minted id, append-only event log held by a sink beside the bit, never read by the render path (§9, ADR 0005). Closes former open question 6. |
| 2026-09-05 | Event set gains `destroyed` so a log can replay removal; `created` carries color. Presence toggles are container-mediated (§9.2–9.3). |
| 2026-09-05 | Emission is a fixed struct of optional color, light, data (§3.2). Closes former open question 2. |
| 2026-09-05 | Back-facing test is inclusive at the plane with ε = 1e-4 on the cosine (§8.2). |
| 2026-09-05 | Orthographic cameras test facing against a direction, exclusively at the plane, so a straight-down view renders exactly 9 nodes per bit (§8.2). |
| 2026-09-06 | Bits carry a free-form JSON passport, replaced whole by a `passport` event (§9.5). Ids default to UUID v7 for bits and containers (§9.1). Events carry `frame`, and optional `actor` and `cause` from a wrangler context (§9.2, §9.6). |
| 2026-09-06 | Persistence is two files per bit, passport and ledger, in a folder per scene, written ledger-first, store-agnostic; compaction keeps a tail and may drop derivable link events (§10). Closes former open question 5. ADR 0006. |
| 2026-09-06 | Packed scene variant `vpb-scene-pack/1` for stores that count files (§10.8, ADR 0006 amended). First IPFS pin recorded in the Phase 6 journal. |
| 2026-09-06 | A container contract (BitHandle, Container) and a conformance suite. FlatGrid over typed arrays with derived link masks is the default container; Grid is the reference. Containers that derive links may omit link events (§7). ADR 0007. |
| 2026-09-06 | A physical bit shows emissions, not the culled list, and carries its LED map in its passport under `ledMap`; DDP to WLED is the wire (§8.6, §9.5, ADR 0009). |
| 2026-09-06 | A container may hold an Ed25519 key and a `did:web`; the seal is signed with it and a reader who resolves the DID verifies the signature, so the spime test no longer needs to trust the store (§10.3, §10.9, PLAN-3 Phase 11). |
| 2026-09-06 | Work is three annotations under reserved keys, request then result then audit, with an optional reward after a passed audit; large results are stored by content id (§9.7, ADR 0010). |
| 2026-09-06 | A scene carries its own reader: one file with the pack, the SPEC, and the DID document, verifying with the repository's own code (ADR 0012). |
| 2026-09-06 | Seals may be witnessed (a notary key or an RFC 3161 authority attesting the signature's digest at a time) and keys rotate by signed chain in the DID document; a signature witnessed after its key's retirement is `retired` (§10.3, ADR 0013). |
