# ADR 0017: glTF is the interchange; extras carry identity

Date: 2026-09-06. Status: accepted.

## Context

A scene left the repository as a pack or as EPCIS; no 3D tool could open
it. PUNCHLIST.md item 7 asked for the format Blender, game engines, and
browsers already read, with each bit's name and passport riding along and
coming back without losing who the bits are. glTF 2.0 is that format; its
`extras` are reserved for application data and Blender keeps them as
custom properties; `KHR_materials_emissive_strength` carries emission
above one and Blender imports and exports it.

## Decision

- **One node per bit, one shared cube.** A node is translated to the
  bit's position (times the cube size, default 1, so neighbors touch).
  Present bits reference a mesh; absent bits are nodes without one, so
  they round-trip. Destroyed bits are not in the snapshot and are not
  exported as nodes; their history comes with the pack.
- **One material per distinct color and light.** `baseColorFactor` is the
  bit's color; `emissiveFactor` is the color scaled by the mean light of
  the face slots that state one (or 1 when none does), clamped to one;
  a light above one goes to `KHR_materials_emissive_strength`, declared
  in `extensionsUsed` only when used. Per-slot emissions are not
  rendered as six-face materials; that is the stretch not taken.
- **Identity in `extras`.** The node's `extras.vpb` carries the bit's id,
  presence, color, all 26 emissions, and passport. The scene's
  `extras.vpb` carries the format, the container id, the bit count, and,
  by default, the whole packed scene gzipped and base64-encoded, so the
  ledgers travel and an import gives the exported scene back with its
  history. `--no-ledgers` carries state only.
- **Import prefers the pack.** With the pack, the importer unpacks and
  opens it and then applies every node translation that differs from the
  bit's position as one `moved` event under actor `gltf:import`, so an
  edit in Blender is one line in the ledger. Without the pack, the bits
  are rebuilt from the nodes under the same actor; since the digest is
  over state, not history, it is equal either way.
- **A glTF is a copy, not a store.** The reader and the pack remain the
  record; nothing in a glTF is sealed. The pack inside a glTF is sealed
  as it was, and verifies as it did.

## Consequences

- `npm run scene:gltf` and `scene:gltf:import`; `scripts/blender-roundtrip.py`
  for the round trip through Blender in the background.
- The reference scene is 485 nodes, one material, 1.44 MB as a GLB with
  the pack inside; Blender 4.5 imports it, keeps the extras through an
  export, and one moved object comes back as exactly one `moved` event.
- The Khronos validator is a dev dependency for the test only. A web
  viewer check is not automated; Blender and the validator are the
  oracles.
- Tools that drop unknown extras lose the pack; the importer then falls
  back to the nodes, which still carry every bit's identity and state.
