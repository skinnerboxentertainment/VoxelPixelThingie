# ADR 0002: Slot ordering from one sign convention

Date: 2026-09-05. Status: accepted.

## Context

The 26 nodes of a bit need a fixed local index so that `(bit, slot)`
identifies a node without ambiguity across implementations and renderers.
An earlier draft ordered faces `+X, -X, +Y, -Y, +Z, -Z` and left edges and
vertices unspecified.

## Decision

One rule generates every ordering. Each axis has a negative side encoded as
`0` and a positive side encoded as `1`. Axes are ordered X, Y, Z with X as
the least significant bit when packed.

- Faces 0–5: `2 * axis + sign`. So −X, +X, −Y, +Y, −Z, +Z.
- Edges 6–17: `6 + 4 * axisAlong + (signA + 2 * signB)` where A and B are
  the other two axes in X, Y, Z order.
- Vertices 18–25: `18 + (signX + 2 * signY + 4 * signZ)`.

The face order was changed from `+X` first to `−X` first so that faces obey
the same rule as edges and vertices.

## Consequences

- `signsOf` and `slotOf` are exact inverses, and the partner rule for links
  is a sign flip on the offset's nonzero axes.
- Incidence tables (which edges bound which face, which vertices end which
  edge) are derived, not stored, and are verified by tests against the
  tables printed in SPEC.md.
- Any renderer or port must use these numbers. They are the contract.

See SPEC.md §5.3–5.7.
