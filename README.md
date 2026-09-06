# VoxelPixelThingie

A voxel whose faces, edges, and corners are all addressable, emitting nodes
on a network, and which decides for itself what not to draw.

**Live:** https://skinnerboxentertainment.github.io/VoxelPixelThingie/

![The reference cube: an 8×8×8 with a corner carved out, glowing seams along the silhouette](docs/images/reference-cube.png)

The atomic unit is the **VoxelPixelBit**. Each one owns 26 private nodes:
6 faces, 12 edges, 8 vertices. Adjacent bits are joined by explicit links
between touching nodes. Every node can emit color, light, or data. Each bit
tests its own nodes and switches off rendering for anything pressed against
a neighbor, facing away from the camera, or silent. A bit has a stable
identity and an append-only history; the rendering is one expression of it.

Seen straight on, a bit is a pixel with a glowing border. Seen at an angle,
it is an isometric tile. Seen freely, it is a beveled glowing cube.

![Pixel mode: the same block from straight above reads as an 8×8 of pixels](docs/images/reference-pixel.png)

## Demos

Three renderers, one model, one render list:

- **Canvas 2D reference**: software projection, pixel / tile / cube modes.
  The image every other renderer must match.
- **Three.js WebGPU**: three instanced draws, bloom, free orbit, click to
  carve, frame times in the HUD, 8³ to 32³.
- **PixiJS pixel mode**: pixels that are secretly voxels. Two 16×16 layers,
  a carved pattern showing depth, tile toggle.

## Run

```
npm ci
npm test
npm run dev
```

Node 22 runs the TypeScript directly; there is no build step for the model.
`npm run dev` serves the demos on http://localhost:5173.

Other commands: `npm run typecheck`, `npm run lint`, `npm run test:coverage`,
`npm run test:e2e`, `npm run bench`, `npm run bench:memory`,
`npm run bench:frame` (needs `npm run build && npm run preview` running),
`npm run docs:api`.

## Read

- [SPEC.md](SPEC.md): the model. Nodes, links, slot numbering, self-culling,
  identity and history.
- [RESEARCH.md](RESEARCH.md): thirteen ways to render it, from Canvas to
  Unreal, and the 2D / 2.5D / 3D matrix.
- [REPOS.md](REPOS.md): libraries worth integrating or borrowing from.
- [PLAN.md](PLAN.md): the stand-up and demo plan, with the demo script.
- [docs/adr/](docs/adr/): why the decisions were made.
- [docs/journal/](docs/journal/): what happened each phase, with the
  numbers.
- [CONTRIBUTING.md](CONTRIBUTING.md): how a change gets in.

## Numbers that matter

From the journals, this machine, one run each:

| What | Value |
|------|-------|
| Solid 8×8×8 | 512 bits, 216 asleep, 384 faces exposed |
| Memory | about 12.6 KB per bit |
| Camera move, 32³, awake bits only | 2.4 ms median |
| Three.js 32³ orbit with bloom, WebGPU | vsync-locked at 60 Hz, model pass 3.0 ms |
| Straight-down view | exactly 9 of 26 nodes per bit |
