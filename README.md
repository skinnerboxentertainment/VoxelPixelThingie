# VoxelPixelThingie

A voxel whose faces, edges, and corners are all addressable, emitting nodes
on a network, and which decides for itself what not to draw.

The atomic unit is the **VoxelPixelBit**. Each one owns 26 private nodes:
6 faces, 12 edges, 8 vertices. Adjacent bits are joined by explicit links
between touching nodes. Every node can emit color, light, or data. Each bit
tests its own nodes and switches off rendering for anything pressed against
a neighbor, facing away from the camera, or silent.

Seen straight on, a bit is a pixel with a glowing border. Seen at an angle,
it is an isometric tile. Seen freely, it is a beveled glowing cube.

## Run

```
npm ci
npm test
```

Node 22 runs the TypeScript directly. No build step.

## Read

- [SPEC.md](SPEC.md): the model. Nodes, links, slot numbering, self-culling.
- [RESEARCH.md](RESEARCH.md): thirteen ways to render it, from Canvas to Unreal.
- [REPOS.md](REPOS.md): libraries worth integrating or borrowing from.
- [PLAN.md](PLAN.md): the stand-up and demo plan.
- [docs/adr/](docs/adr/): why the decisions were made.
- [CONTRIBUTING.md](CONTRIBUTING.md): how a change gets in.

## Status

Phase 0 of PLAN.md. Model and tests exist. Demos do not yet.
