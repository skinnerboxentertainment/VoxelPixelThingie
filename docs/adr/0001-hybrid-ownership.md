# ADR 0001: Private nodes plus explicit links

Date: 2026-09-05. Status: accepted.

## Context

A VoxelPixelBit has 26 addressable nodes: 6 faces, 12 edges, 8 vertices.
When two bits are adjacent they touch on one face, four edges, and four
vertices. The model had to decide whether those touching elements are one
shared node with two owners, or two private nodes, one per bit.

Shared nodes make a true lattice and use roughly a quarter of the memory,
but cannot express opposing emission across a boundary, and removing a bit
reassigns up to 26 co-owned nodes. Private nodes keep each bit portable and
independent but lose adjacency.

## Decision

Every node belongs to exactly one bit. Adjacency is recorded separately as
explicit links between touching nodes of different bits. A face links to
one opposing face, an edge to up to three, a vertex to up to seven. Links
carry no state in v0.1.

## Consequences

- A bit can be created, destroyed, moved, or serialized without altering
  any other bit's nodes.
- Opposing emission across a boundary is legal.
- Node addressing needs no neighbor lookup: `(bit, slot)`.
- Memory is the highest of the three options: 26 nodes per bit plus the
  link table.
- On an axis-aligned grid the link table is derivable from positions and
  may be computed rather than stored until links carry state or bits leave
  the grid.

See SPEC.md §4 and §7.
