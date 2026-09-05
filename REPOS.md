# Repositories Worth Integrating or Borrowing From

Survey v1, 2026-09-05. Companion to RESEARCH.md.

Labels: **[V]** verified today by search. **[T]** trusted from prior
knowledge. Licenses are [T] unless stated; check before shipping.

Each entry ends with one of three calls. **Integrate:** add it as a
dependency. **Borrow:** read it and take the technique, not the code.
**Skip:** noted so nobody re-evaluates it.

---

## The headline finding

No repository found today models a voxel as 26 addressable emitters with
explicit links. Every voxel engine, mesher, and format on this list treats a
voxel as one cell with one color, and edges and vertices do not exist as
things. That is the gap SPEC.md fills. The repos below are therefore
renderers, containers, transports, and reference implementations to sit
around the model, not replacements for it.

Two consequences follow. **Greedy meshing is mostly wrong for VPBs**: it
merges coplanar faces into big quads, which destroys per-face emission
unless neighboring faces happen to match. **Voxel file formats are import
only**: `.vox` carries one color per cell and cannot round-trip a VPB.

---

## Shortlist: integrate these first

| Repo | Role | Why |
|------|------|-----|
| mrdoob/three.js | 3D web renderer | WebGPU-ready, instancing, TSL bloom built in |
| pixijs/pixijs | 2D and 2.5D web renderer | best pure-2D fit; `PerspectiveMesh` for pseudo-3D |
| graphology/graphology | link graph | the network layer, with traversal algorithms for free |
| NateTheGreatt/bitECS | struct-of-arrays store | when bit count outgrows objects |
| pmndrs/postprocessing | bloom for Three.js WebGL path | selective bloom, with a known instancing caveat |
| kevzettler/parse-magica-voxel | `.vox` import | author shapes in MagicaVoxel, light them as VPBs |
| ShiftLimits/wled-client | LED transport | drive a physical cube from the same render list |
| fb39ca4 Branchless Voxel Raycasting | ray-march reference | the DDA every voxel shader descends from |

---

## Web rendering

### mrdoob/three.js
https://github.com/mrdoob/three.js. r184, April 2026 [V]. `WebGPURenderer`
with WebGL 2 fallback since r171 [V]. Official WebGPU bloom example at
threejs.org/examples/webgpu_postprocessing_bloom.html using `bloom` and
`pass` from `three/tsl` [V]. `InstancedMesh`, `BatchedMesh`, fat lines in
addons [T]. MIT.
**Integrate.** The 3D adapter target.

### pixijs/pixijs
https://github.com/pixijs/pixijs. v8.19, June 2026 [V]. `PerspectiveMesh`
with `setCorners`, `Mesh` with custom `MeshGeometry`, `ParticleContainer`,
`CullerPlugin`, `BlurFilter` [T, skills installed locally]. MIT.
**Integrate.** The 2D and 2.5D adapter target, and a viable pseudo-3D one.

### pmndrs/postprocessing
https://github.com/pmndrs/postprocessing. Efficient post-processing for
Three.js with `SelectiveBloomEffect` [V]. Known issue: selecting individual
instances inside an `InstancedMesh` is not supported; a depth override
material workaround exists [V]. MIT.
**Integrate** on the WebGL path only. On WebGPU, use TSL bloom instead and
avoid the instancing caveat entirely.

### BabylonJS/Babylon.js
https://github.com/BabylonJS/Babylon.js. 8.x, all core shaders in GLSL and
WGSL [V]. Node Material Editor targets WGSL [V]. `thinInstance`, `GlowLayer`
[T]. Apache 2.0.
**Borrow** the Node Material Editor to prototype the in-shader bevel, even if
Three.js ships. The graph exports to GLSL that ports.

### pixijs-userland/projection and jnsmalm/pixi3d
https://github.com/pixijs-userland/projection (PixiJS v6 only [V]),
https://github.com/jnsmalm/pixi3d (PixiJS v5 to v7 only [V]).
**Skip.** Neither supports v8. This confirms the plan to do our own
projection on top of v8's `PerspectiveMesh`, which is the core replacement.

---

## Voxel engines in JavaScript

### fenomas/noa
https://github.com/fenomas/noa. Experimental voxel game engine on Babylon.js,
active, v0.30 with type declarations, voxel IDs to 65535, on npm as
`noa-engine` [V]. Peer dependency `@babylonjs/core` [V].
**Borrow.** Its chunking, world-gen pause, and manual chunk loading are the
right shape for a `Grid` container. Its meshing is per-cell color and would
have to be replaced.

### joshmarinacci/voxeljs-next
https://github.com/joshmarinacci/voxeljs-next. Modern rewrite of voxel.js on
current Three.js with VR/AR support [V].
**Borrow.** Reference for a Three.js voxel scene with WebXR wired in.

### Lallassu/voxelengine3, YigitGunduc/voxel-engine
https://github.com/Lallassu/voxelengine3 and
https://github.com/YigitGunduc/voxel-engine. Small Three.js voxel engines
[V].
**Skip.** Useful only as reading; nothing to integrate.

---

## Meshing

### mikolalysenko/greedy-mesher
https://github.com/mikolalysenko/greedy-mesher. The canonical JavaScript
greedy mesh compiler, from the 0fps article [V].
**Borrow, with the caveat.** Only apply it to runs of faces whose emission
matches. Otherwise it erases the model.

### cgerikj/binary-greedy-meshing and Inspirateur/binary-greedy-meshing
https://github.com/cgerikj/binary-greedy-meshing (C++, 50 to 200 µs per
chunk [V]) and https://github.com/Inspirateur/binary-greedy-meshing (Rust
port, roughly 30× faster than block-mesh-rs [V]).
**Borrow** for a Bevy or native build, same caveat.

---

## Ray marching and ray tracing

### fb39ca4, Branchless Voxel Raycasting
https://www.shadertoy.com/view/4dX3zl. 2013, based on the lodev DDA
tutorial, itself a branchless form of Amanatides and Woo [V]. Forked widely
with texturing, ambient occlusion, and SDF hybrids [V]. A compute.toys port
exists at compute.toys/view/78 [V].
**Borrow.** This is the traversal for option 6 in RESEARCH.md. Add the
edge-and-vertex distance shading on top of the hit.

### gnikoloff/webgpu-raytracer
https://github.com/gnikoloff/webgpu-raytracer. Real-time path tracing via
WebGPU compute shaders, spec-compliant [V].
**Borrow.** The compute pipeline scaffolding, buffer layout, and accumulation
pattern for the raw WebGPU option.

### viktor-ferenczi/godot-voxel
https://github.com/viktor-ferenczi/godot-voxel. GPU DDA voxel renderer for
Godot 4.3 with a reusable shader DDA that accepts custom samplers [V].
**Borrow.** The custom sampler hook is exactly where a VPB's per-node
emission lookup would go if Godot is chosen.

### nphyx/voctopus
https://github.com/nphyx/voctopus. Experimental JavaScript sparse voxel
octree rendered directly by a WebGL shader without meshing [V].
**Borrow** when a VPB scene grows sparse enough that a dense 3D texture is
wasteful.

### dubiousconst282, fast voxel ray tracing with sparse 64-trees
https://dubiousconst282.github.io/2024/10/03/voxel-ray-tracing/. Write-up on
64-tree traversal with DDA stepping [V].
**Borrow** as the reading for the next step past voctopus.

---

## Formats

### kevzettler/parse-magica-voxel
https://github.com/kevzettler/parse-magica-voxel. Parses `.vox` in browser
and Node, on npm [V].
**Integrate** for import. Author a shape in MagicaVoxel, load it as presence
and base color, then light nodes as VPBs.

### matthewjosephtaylor/magica-voxels, straku/vox-parser
https://github.com/matthewjosephtaylor/magica-voxels (TypeScript, modern
ES6 [V]) and https://github.com/straku/vox-parser (tiny [V]).
**Alternates** to the above if TypeScript types or size matter more.

**Gap.** No format carries 26 emitters per cell. VPB needs its own file
format. JSON of the render list is enough to start.

---

## Data structures

### graphology/graphology
https://github.com/graphology/graphology. Directed, undirected, or mixed
graph object with a standard library of traversals, generators, and layouts;
TypeScript types included [V]. MIT.
**Integrate** as the link layer once links carry state (SPEC.md §4.2 v0.2).
Every node becomes a graph node keyed `bitId:slot`; every link an edge.
Flood fill, shortest path, and connected components arrive for free, which
is what "nodes on a network" wants.

### NateTheGreatt/bitECS
https://github.com/NateTheGreatt/bitECS. Minimal struct-of-arrays ECS,
entities are numeric IDs, queries instead of systems, v0.4.0 [V]. MIT.
**Integrate** when a class per bit stops scaling. The 26 emissions become
typed arrays indexed by `bit * 26 + slot`, which is the flat index SPEC.md
§5.2 already defines. The self-test becomes a query over dirty bits.

### hmans/miniplex
https://github.com/hmans/miniplex. Developer-friendly ECS with strong
TypeScript and React integration [V].
**Alternate** to bitECS if ergonomics beat raw throughput.

---

## Engine plugins

### Zylann/godot_voxel
https://github.com/Zylann/godot_voxel. C++ module and GDExtension for Godot
4.4.1+, 3.9k stars, blocky and smooth terrain, physics, infinite worlds [V].
**Borrow.** Mature chunk streaming and editing. Its mesher is per-cell; a VPB
build would replace the mesher and keep the world container.

### VoxelPlugin/VoxelCore
https://github.com/VoxelPlugin/VoxelCore. Open-source core of Voxel Plugin
for Unreal: high-performance containers, helper macros, updated June 2026
[V].
**Borrow** if Unreal is chosen. The full Voxel Plugin is commercial [T].

### splashdust/bevy_voxel_world
https://github.com/splashdust/bevy_voxel_world. Multithreaded meshing, chunk
lifecycle, procedural plus persisted layers, meshing by block-mesh-rs [V].
**Borrow** the two-layer world design. Replace the mesher.

### bevy_vox_scene, Game4all/bevy_vox_mesh
https://crates.io/crates/bevy_vox_scene and
https://github.com/Game4all/bevy_vox_mesh. Load `.vox` directly into Bevy
[V].
**Integrate** for import on a Bevy build.

### Dudejoe870/Voxelore
https://github.com/Dudejoe870/Voxelore. Open-source Unity voxel engine, not
yet split from its game [V].
**Skip** for now. Re-check if Unity is chosen.

---

## Borrowed worlds

### luanti-org/luanti
https://github.com/luanti-org/luanti. Open-source voxel game platform,
formerly Minetest, 800+ contributors as of January 2026 [V]. Lua modding.
**Borrow** as the fastest route to a multiplayer VPB world where faces
glow. Edges and vertices are lost.

### FabricMC/fabric-api
https://github.com/FabricMC/fabric-api. Essential hooks for Minecraft
modding, including a rendering API built for compatibility with optimization
mods [V].
**Borrow** for the same purpose in Minecraft. Emissive block textures are a
solved problem in that ecosystem [V].

---

## Physical transport

### ShiftLimits/wled-client
https://github.com/ShiftLimits/wled-client. JS interface for WLED from Node
or the browser, JSON API and WebSocket, on npm [V].
**Integrate.** Control plane for a WLED-driven cube.

### DDP, Distributed Display Protocol
https://kno.wled.ge/interfaces/ddp/. WLED's real-time pixel protocol,
designed to pack pixel data into single Ethernet frames [V]. A TypeScript
`dgram` sender alongside `wled-client` is documented [V].
**Integrate** as the data plane. Twenty lines over UDP.

### jeffreykog/node-artnet-protocol, Granjow/artnet-base, margau/dmxnet
https://github.com/jeffreykog/node-artnet-protocol,
https://github.com/Granjow/artnet-base, https://github.com/margau/dmxnet.
Art-Net senders for Node [V]. WLED accepts Art-Net since v0.10 [V].
**Alternate** to DDP when the target is stage gear rather than WLED.

---

## Not found, and what that means

Searched for and did not find: a voxel library with per-face, per-edge, or
per-vertex state; a voxel format that stores more than one value per cell; a
PixiJS v8 pseudo-3D plugin; a JavaScript voxel engine on WebGPU compute.

The first two are the project's contribution. The third is a small amount of
code on top of `PerspectiveMesh`. The fourth is option 5 in RESEARCH.md and
would itself be a publishable repo.

---

## Sources

[three.js releases](https://github.com/mrdoob/three.js/releases),
[WebGPU bloom example](https://threejs.org/examples/webgpu_postprocessing_bloom.html),
[TSL field guide](https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/),
[pmndrs/postprocessing](https://github.com/pmndrs/postprocessing),
[selective bloom and InstancedMesh](https://github.com/pmndrs/postprocessing/discussions/520),
[pixi-projection](https://github.com/pixijs/pixi-projection),
[pixi3d](https://github.com/jnsmalm/pixi3d),
[noa](https://github.com/fenomas/noa/blob/master/docs/history.md),
[voxeljs-next](https://github.com/joshmarinacci/voxeljs-next/),
[greedy-mesher](https://github.com/mikolalysenko/greedy-mesher),
[binary-greedy-meshing](https://github.com/cgerikj/binary-greedy-meshing),
[Rust port](https://github.com/Inspirateur/binary-greedy-meshing),
[Branchless Voxel Raycasting](https://www.shadertoy.com/view/4dX3zl),
[compute.toys port](https://compute.toys/view/78),
[webgpu-raytracer](https://github.com/gnikoloff/webgpu-raytracer),
[godot-voxel GPU DDA](https://github.com/viktor-ferenczi/godot-voxel),
[voctopus](https://github.com/nphyx/voctopus),
[sparse 64-trees](https://dubiousconst282.github.io/2024/10/03/voxel-ray-tracing/),
[parse-magica-voxel](https://github.com/kevzettler/parse-magica-voxel),
[magica-voxels](https://github.com/matthewjosephtaylor/magica-voxels),
[vox-parser](https://github.com/straku/vox-parser),
[graphology](https://github.com/graphology/graphology),
[bitECS](https://github.com/NateTheGreatt/bitECS),
[miniplex](https://github.com/hmans/miniplex),
[godot_voxel](https://github.com/Zylann/godot_voxel),
[VoxelCore](https://github.com/VoxelPlugin/VoxelCore),
[bevy_voxel_world](https://github.com/splashdust/bevy_voxel_world),
[bevy_vox_scene](https://crates.io/crates/bevy_vox_scene),
[bevy_vox_mesh](https://github.com/Game4all/bevy_vox_mesh),
[Voxelore](https://github.com/Dudejoe870/Voxelore),
[luanti](https://github.com/luanti-org/luanti/),
[fabric-api](https://github.com/FabricMC/fabric-api),
[wled-client](https://github.com/ShiftLimits/wled-client),
[DDP](https://kno.wled.ge/interfaces/ddp/),
[WLED Art-Net](https://kno.wled.ge/interfaces/e1.31-dmx/),
[node-artnet-protocol](https://github.com/jeffreykog/node-artnet-protocol),
[artnet-base](https://github.com/Granjow/artnet-base),
[dmxnet](https://github.com/margau/dmxnet).
