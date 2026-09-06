# VoxelPixelThingie, Program 2: Scale, Speed, Interchange, Hardware

Plan v1, 2026-09-06. Follows PLAN.md (Phases 0 to 5) and Phase 6 in the
journals. Companion to SPEC.md v0.4, docs/spime-research.md, RESEARCH.md.

Labels: **[V]** verified today by search or by a measurement in this
repository's journals. **[T]** trusted from prior knowledge. Everything
here is a proposal; nothing in it has been executed.

---

## Objective, non-goals, assumptions, validation

**Objective.** Four phases, each removing one limit the first program left
in writing: the size ceiling, the browser save time, the absence of an
interchange format, and the absence of a physical expression.

**Non-goals.** No engine ports. No multi-user editing. No new renderer. No
change to what a VoxelPixelBit is: 26 nodes, private, linked, self-culling,
identified, and historied.

**Assumptions.**
- One engineer plus the review agents, the same ritual as CONTRIBUTING.md.
- Phase 10 needs parts bought and a place to solder; parts are Oscar's
  purchase, lead time about a week, ordered on Day 1 so they arrive by
  Phase 10.
- Docker is optional. Phase 9's primary oracle is offline schema
  validation; the live capture oracle is a stretch if Docker is present.

**Validation.** Each phase has a named oracle that can fail, run in CI
where CI can reach it, and recorded with the SHA in the journal where it
cannot. Numbers below marked "today" are from Phase 1 to 6 journals [V].

---

## Standards carried forward

The PLAN.md §1 ritual, unchanged: issue with an oracle, branch, implement,
`/intent-check`, `/roast`, `/code-review`, claim audit, squash merge.
Three additions learned in Phases 0 to 6, from the journals:

- A command chain that ends in a merge starts with the oracle and stops
  when it fails.
- A model change is done when the conformance tests pass against every
  container that claims the model, not when one does.
- A number in a PR body is one that a command printed in that session.

---

## Phase 7: Flat-array store, the size ceiling

**Today.** About 12.6 KB per bit: 26 node objects, each with an emission
object and a links array. 32³ costs 403 MB; 64³ exceeds the default heap
[V]. Camera moves at 32³ cost 2.4 ms after the Phase 3 work [V].

**Oracle.**
- A 64³ dense fill completes within Node's default heap and reports under
  400 bytes per bit in `bench:memory`.
- `cameraMoved` at 64³ under 16 ms median; `renderList` at 64³ under 8 ms.
- The reference scene produces the same `sceneDigest` from the flat
  container as from `Grid`.
- Every existing model test passes against both containers through one
  shared conformance suite.

**Design.** A `FlatGrid` that keeps the model's contract with typed arrays.

| Per bit | Storage |
|---------|---------|
| id | `string[]` by index; the index is internal only |
| position | `Int32Array` ×3 |
| present, enclosed, settled | bit flags in a `Uint8Array` |
| linked nodes | one `Uint32Array`, a 26-bit mask derived from neighbor occupancy |
| open, facing, renderEnabled | three `Uint32Array` 26-bit masks |
| emission color, light | `Uint32Array` and `Float32Array` of length 26·N, with a "has" bit |
| emission data, passport | sparse `Map`s keyed by index; rare by design |

The decisive change is links. SPEC.md §7 already says links on a grid are
derivable from positions. `FlatGrid` derives them into a mask and stores
no link objects at all. The masks make the §8 self-test a few bitwise
operations per bit. Cell lookup is a `Map<string, index>` or a dense
occupancy array when bounds are known.

Events still flow: `linked` and `unlinked` become optional for containers
that derive links, recorded as `linkEvents: false` in the manifest so
replay knows not to expect them. That is a one-paragraph SPEC amendment,
and it also cuts the 19 MB ledger problem from Phase 6 at the root.

**Work.**
1. `tests/conformance/` : the existing container tests parameterized over
   a factory, run against `Grid` first to prove the suite is faithful.
2. `src/flat-grid.ts` behind the same public surface: `add`, `remove`,
   `move`, `setPresent`, `wrangle`, `evaluate`, `cameraMoved`, `bits()`,
   `awake`, `renderList` compatibility.
3. `bench:memory` and `bench` gain a container flag; numbers for 8³ to 64³.
4. SPEC.md v0.5: §7 gains "containers may derive links and omit link
   events"; §12 decision.
5. Decide, with the numbers in hand, whether `FlatGrid` becomes the default
   container in v0.5 and `Grid` the reference, or both stay.

**Exit review.** `/falsify` the claim "a scene replayed without link events
reproduces the same links as one replayed with them," on a 4³ with random
removals, 1000 cases.

**Risk.** Two implementations drift. The conformance suite is the only
defense, so it is task 1, not task 5.

---

## Phase 8: Fast browser persistence

**Today.** Save plus reload plus load of an 8³ takes 27.5 s in headless
Chromium, dominated by about a thousand file-handle operations on the
origin private file system [V].

**Oracle.**
- 8³ save, reload, load under 3 s headless; 16³ under 10 s.
- Autosave on, carving continuously at 16³: `bench:frame` p95 unchanged
  within 1 ms of the no-autosave run.
- The scene saved by the fast path opens with `openScene` unchanged and
  verifies its seal.

**Design.** Two steps, the cheap one first.

1. **Packed save.** Save writes one packed file to OPFS instead of 1,025
   files; load reads one. `packScene` and `PackedStore` already exist.
   This alone should take the 27.5 s to about a second [T].
2. **Worker-side sync handles.** For live autosave of the per-bit layout,
   a dedicated worker owns the scene folder and writes with
   `FileSystemSyncAccessHandle`, which is synchronous, exclusive, and not
   subject to the per-call security checks that make main-thread handles
   slow; available in Chrome, Edge, Firefox 111+, Safari 15.2+ [V]. The
   main thread posts event batches; the worker appends ledgers and
   rewrites passports; ordering per bit is preserved by the worker's queue.

**Work.**
1. `save()` and `load()` in the Three.js demo switch to the packed file.
2. `src/store-opfs-worker.ts` plus `src/opfs-worker.ts`, a `FileStore` whose
   operations are messages, with the same ledger-first ordering.
3. Autosave toggle in the demo: every N events or every T seconds,
   whichever first, through the worker store with `SceneSink.resume`.
4. Playwright: the Phase 6 round-trip test with a time assertion, and an
   autosave test that reloads mid-session and finds the last carve.

**Exit review.** `/roast` the worker protocol; message-passing stores hide
ordering bugs well.

**Risk.** Safari's OPFS is unavailable in private browsing [V]; the demo
must say so rather than fail silently, as it already does for "no origin
private file system."

---

## Phase 9: EPCIS export sink, the spime claim made checkable

**Today.** A bit's history exists in the project's own JSON. Nothing
outside the project can read it. docs/spime-research.md §3 maps the event
table onto EPCIS 2.0 almost one to one [V for the standard, T for the
mapping].

**Oracle.**
- `EpcisSink` output validates against the EPCIS 2.0 JSON Schema with no
  errors, for the reference scene and for the Phase 1 carve sequence.
- Every VPB event type appears in the output as the EPCIS type the mapping
  table names, counted and asserted.
- Stretch, if Docker is present: capture the document into OpenEPCIS
  Community Edition, query it back, and the event count matches [V that
  the edition and its capture and query APIs exist].

**Design.** An `EpcisSink` is an `EventSink` that accumulates and emits an
`EPCISDocument` in JSON-LD.

| VPB event | EPCIS 2.0 | Fields |
|-----------|-----------|--------|
| `created` | ObjectEvent, action ADD | epcList `<ns>bit/<id>`, bizStep from `cause`, readPoint from `frame`, ilmd carrying color and initial emission |
| `destroyed` | ObjectEvent, action DELETE | same identity |
| `moved` | ObjectEvent, action OBSERVE | readPoint `frame`, an extension for the cell |
| `emitted` | ObjectEvent, action OBSERVE, sensorElementList | one sensor report per field: color, light, data |
| `linked` / `unlinked` | AssociationEvent, action ADD / DELETE | parentID the bit, childEPCs the neighbor, an extension for the slot pair |
| `passport` | ObjectEvent, action OBSERVE | an extension carrying the passport; ilmd is ADD-only in EPCIS 2.0 |
| `annotated` | ObjectEvent, action OBSERVE | an extension |

`actor` becomes a source or destination party where the CBV allows it and
an extension otherwise. Identifiers are web URIs under the project
namespace, `https://skinnerboxentertainment.github.io/VoxelPixelThingie/ns/`;
the plan said `urn:uuid:`, and OpenEPCIS rejects that form because it
translates every `urn:` identifier as a GS1 URN (Phase 9 journal). The
prefixes are options, so a GS1 Digital Link form stays open for physical
bits.

**Work.**
1. Fetch and vendor the EPCIS 2.0 JSON Schema and JSON-LD context into
   `vendor/epcis/` with their license and source URL.
2. `src/epcis.ts`: the sink, the mapping, a `toEpcisDocument(events)` pure
   function.
3. A validator in tests using a JSON Schema library, pinned.
4. `scripts/export-epcis.ts` writing the document for a scene folder.
5. Stretch: `scripts/epcis-capture-check.ts` against a local OpenEPCIS.

**Exit review.** `claim-auditor` on the mapping table in the research doc
against the shipped code; any row the code does not implement is deleted
from the doc, not left as intent.

**Risk.** The CBV vocabulary may have no clean home for a voxel's "cause";
custom URIs are legal in EPCIS 2.0 [T] and are the fallback.

---

## Phase 10: The physical bit

**Today.** RESEARCH.md option 13 and docs/spime-research.md §5 describe it.
Nothing is built. WLED on an ESP32 drives WS2812-class LEDs and accepts
DDP over UDP [V].

**Oracle.**
- Software: a DDP packet decoder in tests asserts the LED buffer the sink
  emits for the reference scene: byte layout, sequence, and the slot-to-LED
  map, with no hardware.
- Hardware, recorded on video and in the journal: carve a bit in the
  Three.js demo and the physical bit's matching face goes dark within one
  frame of the demo, measured by the timestamp of the DDP packet against
  the demo's event time.
- The physical bit's QR code opens that bit's passport on the Pages site.

**Bill of materials, one physical bit, about 10 cm.** Prices are rough
and [T]; Oscar buys.

| Part | Quantity | Note |
|------|---------:|------|
| ESP32 dev board | 1 | WLED flashes from the browser |
| WS2812B strip, 60 LEDs per meter | about 1.5 m | cut into 26 segments |
| 5 V power supply, 5 A | 1 | 68 LEDs at half brightness is under 2 A |
| logic level shifter, 3.3 V to 5 V | 1 | optional; short leads usually work |
| frame | 1 | 3D-printed or laser-cut cube with channels for the strips |
| wire, connectors, diffuser film | | |

**LED map.** 6 faces × 4 LEDs, 12 edges × 3 LEDs, 8 corners × 1 LED: 68
LEDs, one strip. The map is a JSON file: slot → LED index range, and it is
the physical bit's passport entry, so the map travels with the bit.

**Design.** A `DdpSink` in Node: consumes the render list or the raw
emissions, builds a 68×3 byte buffer through the map, sends DDP to WLED
on UDP 4048 at up to 30 Hz, with sequence numbers. Nothing in the model
changes; this is one more wrangler.

**Work.**
1. `src/led-map.ts` and `src/ddp.ts`, pure, with the decoder test.
2. `scripts/led-drive.ts`: attach to a scene folder or to the demo over a
   WebSocket and stream frames.
3. The frame, printed or cut, and the strip soldered into it.
4. The QR: a GS1 Digital Link style URL to
   `<pages>/passport/?id=<bit id>`, plus a small passport page in the demo.
5. Journal with the video timestamp measurement.

**Exit review.** `/teachback` on the DDP path, no editor open: what
happens between a click in the browser and a photon.

**Risk.** Wi-Fi jitter makes "within one frame" flaky; report the
distribution over 100 carves, not a single number.

---

## Sequence and days

| Day | Phase | Deliverable | Oracle |
|-----|-------|-------------|--------|
| 1 | 7 | conformance suite over `Grid`; parts ordered for Phase 10 | suite passes on `Grid` |
| 2 | 7 | `FlatGrid` core, links as masks | digest equal on the reference scene |
| 3 | 7 | benches at 64³, SPEC v0.5, default-container decision | memory and timing oracles |
| 4 | 8 | packed save and load in the demo | 8³ under 3 s |
| 5 | 8 | worker store with sync handles, autosave | p95 unchanged with autosave |
| 6 | 9 | schema vendored, `EpcisSink`, mapping | validates |
| 7 | 9 | export script, capture stretch, doc audit | counts match |
| 8 | 10 | `DdpSink`, map, decoder test | packet layout asserted |
| 9 | 10 | frame, strip, first light | a face lights |
| 10 | 10 | click-to-photon measurement, QR, journal | distribution recorded |

Ten working days, the same shape as PLAN.md, which took two calendar days
in practice. Phase 10 is the one that cannot compress: parts have lead
time and soldering has no shortcut.

---

## Ticket seeds

Created only when a phase is started, so their oracles reflect what the
previous phase measured.

| # | Phase | Title |
|---|-------|-------|
| 7.1 | 7 | Conformance suite parameterized over a container factory |
| 7.2 | 7 | FlatGrid with typed arrays and derived link masks |
| 7.3 | 7 | Benches for both containers to 64³; SPEC v0.5 link-event amendment |
| 8.1 | 8 | Packed save and load in the Three.js demo |
| 8.2 | 8 | Worker-side OPFS store with sync access handles; autosave |
| 9.1 | 9 | Vendor EPCIS 2.0 schema and context; EpcisSink with the mapping |
| 9.2 | 9 | Export script; OpenEPCIS capture check as a stretch |
| 10.1 | 10 | LED map and DDP sink with a decoder test |
| 10.2 | 10 | Physical bit: frame, strip, first light |
| 10.3 | 10 | Click-to-photon measurement and the passport QR |

---

## Decisions that are Oscar's

- Buying the Phase 10 parts, on Day 1 for the lead time.
- Whether `FlatGrid` replaces `Grid` as the default in v0.5 once the
  numbers are in.
- Whether Docker is available for the Phase 9 stretch oracle.

---

## Sources consulted today

[FileSystemSyncAccessHandle, MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle),
[createSyncAccessHandle, MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle),
[OPFS, web.dev](https://web.dev/articles/origin-private-file-system),
[OpenEPCIS docs](https://openepcis.io/docs/epcis/),
[OpenEPCIS repository CE](https://github.com/openepcis/epcis-repository-ce),
[OpenEPCIS test data and validation tools](https://openepcis.io/docs/test-data-generator/),
[WLED](https://github.com/wled/WLED),
[WLED UDP realtime control](https://github.com/wled/WLED/wiki/UDP-Realtime-Control),
[DDP write-up](https://blog.jonasbengtson.se/ddp-distributed-display-protocol).
