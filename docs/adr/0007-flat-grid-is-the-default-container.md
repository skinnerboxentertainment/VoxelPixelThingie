# ADR 0007: FlatGrid is the default container; Grid is the reference

Date: 2026-09-06. Status: accepted.

## Context

Phase 1 measured the object-per-node container at about 12.6 KB per bit,
and 64³ exceeded Node's default heap. Phase 7 added a container contract
(ADR 0005 and 0006 did not need one because there was one container), a
conformance suite that states the contract as tests, and a second
container over typed arrays that derives links from neighbor occupancy
instead of storing them. Both pass the same suite and produce the same
scene digest for the reference scene.

Measured on 2026-09-06, this machine, Node 22, one run each, forced GC:

| Size | Bits | Grid heap | Grid B/bit | FlatGrid heap | FlatGrid B/bit | FlatGrid cameraMoved | FlatGrid evaluate |
|------|-----:|----------:|-----------:|--------------:|---------------:|---------------------:|------------------:|
| 8³ | 512 | 8 MB | 15,627 | 1 MB | 1,240 | 0.09 ms | 0.08 ms |
| 16³ | 4,096 | 60 MB | 15,418 | 2 MB | 521 | 0.17 ms | 0.16 ms |
| 32³ | 32,768 | 493 MB | 15,766 | 16 MB | 497 | 0.57 ms | 0.73 ms |
| 48³ | 110,592 | not run | | 37 MB | 347 | 1.67 ms | 1.76 ms |
| 64³ | 262,144 | out of heap | | 64 MB | 254 | 3.41 ms | 10.81 ms |

Grid's per-bit figure grew from 12.6 KB in Phase 1 to about 15.5 KB
because Phase 6 added passports, event stamping, and handle accessors.

## Decision

`FlatGrid` is the default container: `replay`, `openScene`, and the demos
construct it unless a factory says otherwise. `Grid` remains in the
repository as the reference implementation, exported, tested by the same
conformance suite, and used as the oracle when a behavior is in doubt.

Containers may derive links from positions and omit `linked` and
`unlinked` events (SPEC.md §7, v0.5). Replay never needed them; the
Phase 6 compactor already dropped them first.

## Consequences

- The size ceiling moves from about 32³ to well past 64³; memory per bit
  drops sixty-fold at scale.
- Per-frame costs at 32³ fall from 2.25 ms to 0.57 ms for a camera move.
- Ledgers shrink: the reference 8³ scene records 54,392 events on Grid,
  most of them links, and about 14,000 on FlatGrid.
- Two containers must be kept in agreement. The conformance suite and the
  cross-container digest test are the only defense, and they run in CI.
- One precision trap is recorded: a typed array holding a user value must
  be Float64, or 0.6 becomes 0.6000000238 and the digest changes.
- `Grid`'s richer node objects (`bit.nodes[i].links`) are no longer
  something a renderer may rely on; the contract's accessors are.

## Alternatives considered

- **Keep Grid as the default and offer FlatGrid as an option.** Every new
  user would start on the container that cannot scale, and every demo
  would carry both paths.
- **Delete Grid.** It is the executable statement of the model that the
  flat one is measured against. Keeping it costs a test run.
