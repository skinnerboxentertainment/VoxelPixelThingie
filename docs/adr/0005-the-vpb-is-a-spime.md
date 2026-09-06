# ADR 0005: The VoxelPixelBit is a spime

Date: 2026-09-05. Status: proposed.

## Context

Bruce Sterling coined "spime" in *Shaping Things* (2005) for an object
whose data trail is its primary existence: unique identity, a knowable
history from design through disposal, and membership in a network of
information. Physical instances are temporary expressions of the spime.
Sterling's ladder runs artifact, machine, product, gizmo, spime, and the
people who manage spimes are wranglers. Verified against published
summaries of the book on 2026-09-06; see docs/spime-research.md. An
earlier revision of this ADR wrote "gadget" for the fourth rung.

A VoxelPixelBit already sits above "gadget." It is networked through
explicit links, its 26 parts are addressable, and every part emits
information. Two things keep it from being a spime:

1. **Identity is a location.** `id` is the grid cell. A bit that moves, is
   copied into another scene, or is expressed on a laptop and then on an
   LED cube is only the same bit if its identity survives all of that.
   SPEC.md open question 6 asked exactly this.
2. **It has state but no history.** A bit knows its current emission and
   current links. It does not know when it was created, by what, what it
   emitted before, or which neighbors it has lost.

Renderers in RESEARCH.md are, in this framing, wranglers: each is one
expression of the same bit. The physical LED cube (option 13) stops being a
novelty and becomes the most literal instance.

## Decision

Adopt the spime framing as the model's identity and lifecycle contract,
SPEC.md v0.3, with four rules.

**1. Stable identity.** Every bit carries an immutable, opaque `id` minted
by its container at creation. Position is a mutable property, not the
identity. Two bits with the same id are the same bit. The id survives
moves, serialization, and re-expression in any renderer. The container
(the `Grid` planned for Phase 1) owns the generator; the bit never mints
its own.

**2. Append-only history.** Every change to a bit is an event, and events
are recorded in an append-only log keyed by bit id. The event set in v0.3:

| Event | Payload |
|-------|---------|
| `created` | position, initial emission |
| `presence` | present or absent |
| `emitted` | slot, emission |
| `linked` | neighbor id, slot, partner slot, offset |
| `unlinked` | neighbor id, slot |
| `moved` | from, to |
| `annotated` | free-form key and value |

Every event carries a monotonic sequence number and a timestamp supplied
by the container. The log is the bit's lifecycle; the bit's fields are a
projection of it.

**3. The log lives beside the bit, not inside it.** Bits emit events to a
sink provided by the container. The default sink discards. The bit's
memory footprint and the render path (SPEC.md §8) do not change. A scene
that wants history installs a recording sink. A scene that wants replay
folds the log back into bits.

**4. History never enters `evaluate`.** The self-test reads current state
only. Nothing in the render path consults the log. This is what keeps
Phases 1 through 5 of PLAN.md unaffected by this decision.

The `data` field of `Emission` remains an open channel for what a node
says to the network. Provenance is the log, not `data`.

## Consequences

- Open question 6 is closed: identity is a stable id, not the grid cell.
- A bit can be moved, exported to Blender, driven onto an LED cube, and
  re-imported, and remain the same bit with the same history.
- Replay, undo, and "what did this wall look like at frame 1200" become
  folds over the log rather than features.
- Memory grows with history. Sinks must own a cap or compaction policy.
  v0.3 specifies the event contract, not retention. Retention is a sink
  concern and a later ADR.
- Serialization now has two shapes: a snapshot (bits as they are) and a
  ledger (events as they happened). The JSON render list planned for
  Phase 2 is a third, renderer-facing shape and is unaffected.
- Implementation lands as a Phase 1 ticket: `id` becomes a constructor
  argument minted by `Grid`, the existing mutators emit events to a sink,
  and one recording sink with a test that replays a carve sequence to the
  same end state. Estimated under 100 lines plus tests.

## Alternatives considered

- **Keep the grid cell as identity and add a log keyed by position.** Fails
  the moment a bit moves; the history splits.
- **Put the log on the bit.** Simplest to write, but every bit pays for
  history whether or not the scene wants it, and the render path would sit
  next to an unbounded array.
- **Do nothing until a feature needs it.** Every future feature that needs
  identity would mint its own, and they would disagree.
