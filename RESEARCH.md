# Bringing VoxelPixelBits to Life

Research v3, 2026-09-05. Companion to SPEC.md and src/.

Labels: **[V]** verified today by search or by running code. **[T]** trusted
from prior knowledge. Versions and dates are [V]; how an engine works
internally is [T] unless stated.

---

## The decision

**Tonight:** Canvas 2D. One HTML file, the existing scaffold, an 8×8×8 with a
corner carved out. This is the reference image.

**This week:** Three.js with the WebGPU renderer. Three instanced draws fed
from the model, bloom on emission, orbit controls, WebXR for free.

**In parallel:** ray marching for the signature look, and a WebGPU compute
pass for the proof that the self-test in SPEC.md §8 belongs on the GPU.

**Later:** Bevy or Godot for a product, Blender for the poster, an LED cube
for the table.

**Before any of it:** two small engine-agnostic additions to `src/`. A
`renderList()` that walks enabled nodes after `evaluate`, and a `Grid` that
links neighbors on insert. About 70 lines together.

---

## The grid

| # | Option | Family | First pixel | Edge and vertex glow | Ceiling | Self-cull fit | Full orbit | Reach |
|---|--------|--------|-------------|----------------------|---------|---------------|:----------:|-------|
| 1 | Canvas 2D | web, pseudo-3D | < 1 h | hand-drawn | low | total | ✓ | any browser |
| 2 | PixiJS v8 | web, pseudo-3D | 2–3 h | good | mid | good | ✓ | any browser |
| 3 | Three.js r184 | web, 3D | 2–4 h | good | high | good | ✓ | browser, XR |
| 4 | Babylon.js 8 | web, 3D | 3–4 h | best, in-shader bevel | high | good | ✓ | browser, XR, native |
| 5 | Raw WebGPU | web, 3D | 1–3 d | good | very high | best | ✓ | browser, native |
| 6 | Ray marching | web, shader | 4–8 h | perfect | pixel-bound | exact | ✓ | anywhere |
| 7 | Godot 4.5 | engine | ½ d | good | high | fine | ✓ | desktop, mobile, web |
| 8 | Unity 6.6 | engine | 1 d | good | very high | excellent | ✓ | everything |
| 9 | Unreal 5.7 | engine | 1–2 d | good, real GI | highest visual | awkward | ✓ | desktop, console |
| 10 | Bevy 0.19 | engine | ½–1 d | good | very high | excellent | ✓ | native, WASM |
| 11 | Blender 5 | offline | 2–3 h | perfect | render-time | n/a | ✓ | image, video |
| 12 | Minecraft, Roblox | borrowed world | 1 h–½ d | faces only | very high | theirs | ✓ | huge audience |
| 13 | LED cube | physical | an evening | literal | hardware | moot | ✓ | a room |

---

## What has to be drawn

A VPB is not a plain cube. It is a **beveled, glowing cube** with 26
emitters: 6 lit panels, 12 glowing seams, 8 glowing corner beads.

Every option draws panels well. Seams and beads are where they separate,
because most engines treat lines and points as thin unlit debug primitives.
Three ways to get a glowing seam:

- **Geometry.** Thin tubes for edges, small spheres for vertices. Simple,
  costly in bulk.
- **In-shader bevel.** One quad per face; the fragment shader computes
  distance to the nearest edge and vertex from the face UV and shades a seam
  band or a bead disc. Collapses 26 nodes into one draw.
- **Bloom.** Post-process glow on anything emissive. Works with either of the
  above.

**The model does the culling.** Every renderer below receives only nodes
whose `renderEnabled` is true. The engine's own culling is welcome but not
relied on. Orbit works everywhere because the bit's back-facing test only
needs the camera position, and link-based hiding never changes with the view.

**One adapter per target.** `VoxelPixelBit[]` → `evaluate(camera)` →
render list of `{ bit, slot, emission, center, outward }` → adapter draws.
Nothing in SPEC.md changes per target.

---

## Web, pseudo-3D

### 1. Canvas 2D

The `<canvas>` 2D context. No library, no build. Project every visible
node's position on the CPU, sort bits back to front by view depth, paint
faces as polygons, edges as strokes with `shadowBlur`, vertices as arcs.
Grid-aligned equal cubes never overlap cyclically, so the painter's sort
holds [T].

- **Wins:** first pixel in under an hour. The bit is the only culler.
- **Limit:** a few thousand visible faces at 60 fps [T]. No depth buffer.
- **Verdict:** the right first move and the reference image.

### 2. PixiJS v8

GPU-batched 2D over WebGL or WebGPU. v8.19 current as of June 2026 [V]. The
workspace has PixiJS v8 skills installed. Same CPU projection as option 1,
but the projected points go into `Graphics` quads, a `Mesh` with a custom
`MeshGeometry`, or `PerspectiveMesh.setCorners` for perspective-correct
textured faces [T]. Glow from a `BlurFilter` on an emissive layer. Off-screen
culling via `CullerPlugin`.

- **Wins:** tens of thousands of faces batched [T]. Reads as "pixels."
- **Limit:** re-projects every visible node every frame. No depth buffer.
- **Verdict:** the choice if the look should stay pixel-flavored. Fixed
  isometric or free orbit both work.

---

## Web, true 3D

### 3. Three.js r184, WebGPU renderer

r184 shipped April 2026 [V]. `WebGPURenderer` production-ready since r171
with automatic WebGL 2 fallback [V]. WebGPU is default-on in Chrome, Edge,
Firefox, and Safari including iOS 26 and visionOS 26 [V].

One `InstancedMesh` each for faces, edges, and vertices. Per-instance
transform from `nodeCenter` and `outwardOf`, per-instance color from
emission. Fat lines from `three/addons` for edges if tubes are too heavy [T].
Bloom via `UnrealBloomPass` or the TSL `bloom()` node [T]. `OrbitControls`
is one line. WebXR to Quest 3 and Vision Pro through the same renderer [V].

- **Wins:** three draws render the world regardless of bit count. Mature.
- **Limit:** bloom is the cost center on mobile.
- **Verdict:** the default for a real interactive build.

### 4. Babylon.js 8

8.0 shipped March 2025 with every core shader in both GLSL and WGSL, so
WebGPU is native [V]. Same instancing plan using `thinInstance` buffers [T].
The differentiator is the **Node Material Editor**, a visual shader graph
that targets WGSL [V]: the in-shader bevel is exactly what it is for.
`GlowLayer` is turnkey [T]. `ArcRotateCamera` built in. Babylon Native for
iOS, Android, and desktop from the same code [T].

- **Wins:** the best path to a one-draw beveled cube. Better inspector.
- **Limit:** bigger bundle, smaller community.
- **Verdict:** pick over Three.js if the in-shader bevel or a native app
  target matters early.

### 5. Raw WebGPU with compute self-test

No engine. A storage buffer holds every bit: position, presence, 26
emissions, and a 26-bit link mask in one `u32`. A compute shader, one thread
per bit, runs §8.2 in order: presence, enclosure, then per node silence,
link occlusion, back-facing, frustum. Survivors append to an instance buffer
through an atomic counter that feeds an **indirect draw**. The CPU never
touches visibility. §8.3's dirty flags map to "dispatch only when dirty."

- **Wins:** millions of bits [T]. The spec running on hardware.
- **Limit:** everything else is hand-built. GPU-side bugs are slow to find.
- **Verdict:** the R&D proof. Spike it after option 3 exists.

### 6. Ray marching, no geometry

One full-screen fragment shader. Bits live in a 3D texture. Each pixel
marches a ray through the grid with DDA until it hits a present bit, then
measures distance from the hit point to the nearest edge and vertex.
Threshold those and the face, seam, and bead fall out of the shading
function. Occlusion is exact because the ray stops at the first hit. The
link mask and enclosure flag become traversal hints.

- **Wins:** the most faithful VPB rendering possible. Pixel-perfect seams at
  any zoom. Cost scales with screen pixels, not bit count.
- **Limit:** hard to mix with ordinary geometry, text, or UI in the same
  space. One shader to maintain.
- **Verdict:** the signature look. May become the face material for 3 or 4.

---

## Engines

All four need a port of `vpb.ts` (under 300 lines) or a socket that streams
the render list from Node.

### 7. Godot 4.5

Open source, MIT. 4.5 shipped September 2025 [V]. `MultiMeshInstance3D` per
node type with per-instance color [V]. `WorldEnvironment` glow is a
checkbox [T]. Exports to desktop, mobile, and web [T].

- **Verdict:** best free engine for a shippable app with a scene editor.

### 8. Unity 6.6, Entities

6.6 released September 1, 2026 [V]. Entities (DOTS) now described as
production-ready [V]. A bit is an entity, its nodes a buffer, links entity
references. The §8 self-test is a Burst job across all cores [T]. Entities
Graphics instances the survivors; VFX Graph renders beads as GPU particles
[T].

- **Verdict:** the tightest fit between the spec's architecture and an
  engine's. Licensing has been volatile [T].

### 9. Unreal 5.7

5.7 current, Nanite Foliage and Nanite Voxels experimental, PCG
production-ready [V]. Instanced static meshes with per-instance custom data
for faces and edges, Niagara particles for vertices [T]. **Lumen** makes
emission real: a glowing face lights its neighbors. Nanite Voxels are tuned
for foliage; do not plan around them [V]. No supported web export [T].

- **Verdict:** the cinematic option. Wrong tool for model R&D.

### 10. Bevy 0.19

0.19 shipped June 2026 with an experimental first-party editor [V].
Rendering is wgpu, one codebase to Vulkan, Metal, D3D12, and WebGPU [V].
Same ECS argument as Unity, in Rust, open source, with a WASM browser build
for free.

- **Verdict:** the serious native engine path without licensing risk. API
  churn per release [T].

---

## Off the screen

### 11. Blender 5, offline

5.0 current, 5.2 LTS adds Geometry Nodes physics [V]. Export the render list
as JSON; a Python script or Geometry Nodes instances a quad, tube, or sphere
per node with emission as an attribute [T]. Cycles renders physically
correct glow, depth of field, motion blur.

- **Verdict:** the poster, and the cheapest way to see what seams and beads
  should look like before tuning a real-time shader to match.

### 12. Borrowed voxel worlds

Minecraft with Fabric, Luanti (formerly Minetest) [V], or Roblox with
scriptable parts and terrain [V]. A bit is a block; face emission is a
light level and an emissive texture, a solved problem [V]. Edges and
vertices have no native form. Their meshing already skips hidden faces [T].

- **Verdict:** a living multiplayer VPB world in an afternoon, at the cost
  of the model's most distinctive feature.

### 13. Addressable LED cube

ESP32 running WLED, v16 current [V], driving WS2812-class LEDs. 3D matrices
of 294 to 512 nodes are documented builds [V]. Two layouts: one LED per bit
in a lattice, or one small cube per bit with LEDs on faces, edges, and
corners, which is the literal VPB. Drive it over DDP or Art-Net from the
TypeScript model [T]. Enclosure detection still matters: do not wire LEDs
into interior faces.

- **Verdict:** the one where "nodes on a network that emit light" stops
  being a metaphor.

---

## 2D, 2.5D, and 3D across every stack

The three modes are not three products. They are three camera contracts
against the same model, and the model tells you exactly which nodes can ever
be seen in each.

| Mode | Camera | Nodes that can render | What a VPB reads as |
|------|--------|-----------------------|---------------------|
| Pure 2D | orthographic, straight down the Z axis | 9: the +Z face, its 4 edges, its 4 vertices | a pixel with a glowing border and corner beads |
| 2.5D | orthographic, fixed oblique angle (isometric or dimetric) | 19: 3 faces, 9 edges, 7 vertices | a chunky isometric tile |
| 3D | perspective, free | all 26, decided per frame | a beveled glowing cube |

**Pure 2D is where the "Pixel" in the name lives.** A layer of bits is a
display panel. Seventeen of the 26 nodes are permanently off, the self-test
collapses to "is there a bit in front of me," and depth becomes a layer
index. Sixteen bits in a row is a glowing 16-pixel strip with seams between
them. This mode is worth building first because it is the cheapest and it
is the one no other voxel project has.

**2.5D is the sprite mode.** Every bit has the same silhouette from a fixed
angle, so one sprite atlas with per-node tint covers every bit. Painter's
sort by `x + y + z`. This is the classic pseudo-3D pixel-art look.

**3D is the general case** and everything in the sections above.

**The rule that falls out:** in a true 3D stack, all three modes are camera
settings. In a 2D stack, 2D is native, 2.5D is a fixed projection, and 3D is
software projection. In the physical world, 2D is a panel and 3D is a cube.

| # | Option | Pure 2D | 2.5D | 3D |
|---|--------|---------|------|----|
| 1 | Canvas 2D | native: `fillRect` per bit, strokes for seams | native: fixed iso projection, painter's sort | software: rotate, perspective-divide, sort |
| 2 | PixiJS v8 | native: `Sprite` per bit, tint per node, best fit of all 13 | native: sprite atlas of one silhouette, tint per node | software: `PerspectiveMesh.setCorners` or `Mesh` per face |
| 3 | Three.js | `OrthographicCamera` down Z | `OrthographicCamera` at iso angle | `PerspectiveCamera` + orbit |
| 4 | Babylon.js | orthographic mode on any camera | same, tilted | `ArcRotateCamera` |
| 5 | Raw WebGPU | orthographic matrix; compute test drops 17 slots | orthographic matrix, tilted | perspective matrix |
| 6 | Ray marching | rays parallel to Z: it becomes a 2D lookup, one texel per bit | parallel rays at iso angle | perspective rays |
| 7 | Godot | `Camera3D` orthogonal, or a `TileMapLayer` in real 2D | `Camera3D` orthogonal, tilted, or 2D iso tiles | `Camera3D` perspective |
| 8 | Unity | orthographic camera, or Unity 2D tilemap | orthographic tilted, or 2D isometric tilemap | perspective |
| 9 | Unreal | orthographic camera, or Paper2D | orthographic tilted | perspective |
| 10 | Bevy | `Camera2d` with sprites | `Camera3d` orthographic tilted | `Camera3d` perspective |
| 11 | Blender | orthographic camera down Z | orthographic at iso angle | any camera path |
| 12 | Minecraft, Roblox | not available: their camera is 3D | not available | native |
| 13 | LED | an LED matrix panel | a cube viewed from a fixed corner | a lattice or a cube |

**Where this changes the earlier recommendation.** PixiJS moves up. It is
the best pure-2D stack on the list, competitive at 2.5D, and viable at 3D.
If the project's identity is "pixels that are secretly voxels," PixiJS is
the one stack that is excellent in the mode that matters most and adequate
in the others. Three.js remains the best pure-3D choice.

---

## Sources

Three.js: [releases](https://github.com/mrdoob/three.js/releases),
[WebGPURenderer](https://threejs.org/manual/en/webgpurenderer.html),
[2026 overview](https://www.utsubo.com/blog/threejs-2026-what-changed),
[WebGPU baseline and WebXR](https://vr.org/articles/webgpu-baseline-2026-three-js-webxr-default).
WebGPU: [web.dev](https://web.dev/blog/webgpu-supported-major-browsers),
[implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status).
Babylon.js: [8.0](https://blogs.windows.com/windowsdeveloper/2025/03/27/announcing-babylon-js-8-0/),
[in 2026](https://thelinuxcode.com/babylonjs-in-2026-building-practical-3d-web-apps-with-webglwebgpu/).
PixiJS: [8.16.0](https://pixijs.com/blog/8.16.0), [June 2026](https://pixijs.com/blog/june-2026).
Godot: [4.5](https://godotengine.org/releases/4.5/),
[MultiMesh](https://docs.godotengine.org/en/4.5/classes/class_multimesh.html).
Unity: [best version 2026](https://makaka.org/unity-tutorials/best-version),
[Entities](https://docs.unity3d.com/6000.3/Documentation/Manual/com.unity.entities.html),
[DOTS in 2026](https://darkounity.com/blog/what-is-unity-dots-in-2026).
Unreal: [5.7](https://www.unrealengine.com/news/unreal-engine-5-7-is-now-available),
[Nanite Foliage](https://80.lv/articles/unreal-engine-5-7-is-now-availabe),
[5.7 performance](https://tomlooman.com/unreal-engine-5-7-performance-highlights/).
Bevy: [news](https://bevy.org/news/), [Bevy + WebGPU](https://bevy.org/news/bevy-webgpu/),
[0.18 guide](https://www.strayspark.studio/blog/bevy-rust-game-engine-2026-indie-guide).
Blender: [5.0](https://www.cgchannel.com/2025/11/blender-5-0-is-out-check-out-its-5-key-features/),
[5.2 LTS](https://www.blender.org/download/releases/5-2/).
LED: [WLED 16](https://blog.adafruit.com/2026/06/19/wled-16-whats-new-led-matrices-adafruitlearningsystem-adafruit/),
[512-node cube](https://www.hackster.io/news/displaying-3d-animations-on-a-giant-512-node-rgb-led-cube-matrix-338258ebe564),
[7×7×6 matrix](https://www.hackster.io/Praveen_Elumalai/3d-led-matrix-b915c3).
WebXR: [visionOS](https://www.vrwiki.cs.brown.edu/hardware/vr-hardware/apple-vision-pro/development-approaches-for-visionos/webxr-on-visionos),
[headsets 2026](https://threejsresources.com/blog/best-vr-headsets-with-webxr-support-for-threejs-developers-2026).
Voxel worlds: [Roblox terrain](https://create.roblox.com/docs/parts/terrain),
[Luanti](https://en.wikipedia.org/wiki/Luanti),
[emissive textures](https://www.planetminecraft.com/texture-pack/basic-emissive-textures/).
