# ADR 0009: The physical bit speaks DDP to WLED, and its LED map rides in its passport

Date: 2026-09-06. Status: accepted.

## Context

RESEARCH.md option 13 and PLAN-2.md Phase 10 describe the one expression
where the nodes literally emit light: a cube frame with one WS2812-class
strip routed through it, driven by an ESP32 running WLED. The model must
not learn anything about hardware; a wrangler outside it turns a bit's
emissions into bytes on a wire.

Two questions had to be settled before any code: which wire protocol, and
where the mapping from the 26 nodes to LED indices lives.

Read on 2026-09-06: the DDP specification at 3waylabs.com/ddp, WLED's
`wled00/src/dependencies/e131/ESPAsyncE131.h` for its constants, and
`wled00/e131.cpp` for its receive path.

## Decision

- **DDP over UDP 4048.** Ten-byte header, version 1, RGB 8-bit data type
  `0x0B`, destination 1, big-endian byte offset and length, at most 1440
  data bytes per packet, push flag on the last packet of a frame. WLED
  computes the first LED as offset divided by channels per LED and renders
  on push, or on every packet until it has seen one. `src/ddp.ts` encodes
  and decodes exactly this; `tests/ddp.test.ts` pins the constants to
  WLED's header file and the bytes to the specification.
- **The map is data, not code.** `vpb-led-map/1` is JSON: the strip length
  and, per slot, a contiguous LED range. It validates (no overlap, no range
  past the strip, 26 entries) and it lives in the bit's passport under
  `ledMap`, so the physical bit carries its own wiring and a driver reads
  it from the same store as everything else. The default is the plan's
  bill of materials: 6 faces × 4, 12 edges × 3, 8 corners × 1, 68 LEDs, in
  slot order.
- **The physical bit shows emissions, not the culled render list.** A
  cube on a desk is seen from every side; a face that a neighbor covers in
  the virtual scene still lights on the desk. An absent bit is dark.
- **Browsers post, Node sends.** A page cannot open a UDP socket. The
  Three.js demo posts the bit's state as `vpb-led-frame/1` JSON to a small
  HTTP bridge (`scripts/led-bridge.ts`) that pushes DDP and records the
  event-to-packet latency, which is the software half of the plan's
  click-to-photon measurement.

## Consequences

- No model change. `ledFrame` reads a `BitRecord`; `DdpSender` is one more
  wrangler, like the exporter and the replayer.
- Art-Net and E1.31 were not chosen: DDP has the smallest header, needs no
  universe arithmetic, and WLED enables it without a setting. Either could
  be added as a second sender behind the same frame bytes.
- The hardware oracle in PLAN-2.md (a carved face goes dark within a frame,
  on video) waits on parts; the software oracle runs in CI: packet bytes
  for the reference bit and a latency distribution over a hundred posts.
