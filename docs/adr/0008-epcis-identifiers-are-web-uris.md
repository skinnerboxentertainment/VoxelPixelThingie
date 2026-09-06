# ADR 0008: EPCIS identifiers are web URIs under the project namespace

Date: 2026-09-06. Status: accepted.

## Context

PLAN-2.md Phase 9 said a bit's EPCIS identifier would be `urn:uuid:<id>`,
the shortest legal URI for a UUID, and the first cut of `src/epcis.ts`
used `urn:vpb:frame:` and `urn:vpb:actor:` for the container and the
actor. EPCIS 2.0 allows any URI in an epcList, a readPoint, or a source.

The stretch oracle, capturing the reference scene into OpenEPCIS Community
Edition, refused every event: OpenEPCIS runs each `urn:` identifier in
those positions through its GS1 identifier translator and raises
`InvalidEPCException: Provided URN format does not match with any of the
GS1 identifiers format`. Probed on 2026-09-06 with single-event captures:
`urn:uuid:` and `urn:vpb:` fail in epcList, readPoint, and sourceList;
`https://` URIs pass in all three; GS1 Digital Link URIs pass; the event id
is not translated and may stay a URN.

## Decision

Bits, containers, and actors are named by web URIs under the project
namespace `https://skinnerboxentertainment.github.io/VoxelPixelThingie/ns/`:

| Thing | Identifier |
|-------|------------|
| bit | `<ns>bit/<uuid>` in epcList, parentID, childEPCs |
| container | `<ns>frame/<container id>` as readPoint |
| actor | `<ns>actor/<slug>` as an owning_party source |
| event | `urn:vpb:event:<container id>:<seq>` |

The three prefixes are options on `toEpcisDocument`, so a deployment can
choose `urn:uuid:` or a GS1 Digital Link form; the tests exercise both.

## Consequences

- The reference scene captures into OpenEPCIS with no per-event changes,
  and every event queries back (Phase 9 journal).
- A web URI under the Pages site is also a place a passport page can live,
  which Phase 10 uses for the physical bit's QR code.
- The Phase 9 plan table was corrected rather than left as intent.
