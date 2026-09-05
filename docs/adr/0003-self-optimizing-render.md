# ADR 0003: The bit culls itself

Date: 2026-09-05. Status: accepted.

## Context

In a scene of many bits, most nodes are never visible: they face a
neighbor, face away from the camera, or belong to a bit that is fully
enclosed or off screen. Something has to decide what not to draw. The usual
answer is a global culling pass owned by the renderer.

## Decision

A VoxelPixelBit is responsible for its own render cost. It tests its own
components and disables whatever it can prove will not contribute to the
frame, without waiting for a global pass. Tests run cheapest first:
presence, silence, occlusion by link, full enclosure, back-facing, frustum,
screen coverage. Tests are event-driven and cached: link-dependent results
hold until a link changes, camera-dependent results hold until the camera
moves. An enclosed bit never runs a camera test.

Render-off is not emit-off. A hidden face still holds state and still emits
into the network through its link.

## Consequences

- Renderers receive only nodes marked `renderEnabled` and need no culling
  of their own, though they may add it.
- The link table makes the occlusion tests free: link count is already
  known.
- The self-test maps naturally onto a GPU compute pass (one thread per bit)
  or an ECS system, which shapes the engine choices in RESEARCH.md.
- At very large scale the tests themselves become the cost and a parent
  grouping will be needed to short-circuit them. The bit still decides; a
  parent only short-circuits.
- The back-facing test uses a hard threshold and can flicker at grazing
  angles. The renderer's own back-face culling covers the visual; a
  tolerance is planned in Phase 1.

See SPEC.md §8.
