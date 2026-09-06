# Spime Research: What the Term Means, What Became Real, and What the VPB Still Lacks

Research v1, 2026-09-06. Companion to ADR 0005 and SPEC.md §9.

Labels: **[V]** verified today by web search. **[T]** trusted from prior
knowledge. Where a date or a standard number is given it is [V] unless
marked.

---

## The decision this document supports

ADR 0005 adopted the spime framing and SPEC.md v0.3 gave the bit a stable
id and an append-only event log. This document checks that framing against
the source and against what has happened since 2005, and proposes the
v0.4 amendments in §6. Short version: the framing was right, one word in
the ADR was wrong, the event table maps almost one-to-one onto a supply
chain standard that has since become law in Europe, and the VPB is missing
three fields to be a spime rather than a very good object.

---

## 1. What Sterling actually said

*Shaping Things*, Bruce Sterling, MIT Press Mediaworks Pamphlets, 2005 [V].

**The word.** "Spime" contracts "space" and "time." A spime is a
manufactured object with informational support so extensive that it is
best regarded as a material instantiation of an immaterial system [V].
The object is the shadow; the data is the thing.

**The ladder.** Artifacts, made by hand. Machines, from roughly the 15th
century. Products, mass-produced. Gizmos, the present tense of 2005:
user-alterable, baroquely multi-featured, programmable. Spimes, next [V].
ADR 0005 wrote "gadget" for the fourth rung. Sterling's word is "gizmo."
This document's PR corrects the ADR.

**The relationships.** Each rung has its human. Artisans make artifacts.
Customers buy machines. Consumers use products. Users operate gizmos.
Spimes have **wranglers** [V]. A wrangler does not own or use a spime so
much as manage its data trail.

**The properties.** Spimes are designed on screens, fabricated by digital
means, precisely tracked through space and time, uniquely identifiable,
enhanceable, and sustainable in a specific sense: made of substances that
fold back into the production stream of future spimes [V]. The lifecycle
ends in recycling, and the recycling is part of the record.

**What is easy to miss.** The book is a sustainability argument first and
a technology forecast second. Tracking is the means; the point is that
nothing gets lost, so nothing gets wasted. That matters for the VPB
because it says what the `destroyed` event is for: not deletion, but
return.

---

## 2. Where the idea came from and where it went

**Before.** Kevin Ashton coined "the Internet of Things" in a 1999
presentation at Procter & Gamble, to sell RFID to management; the
Auto-ID Center followed with MIT and Cambridge [V]. Sterling wrote in the
shadow of that RFID moment.

**Alongside.** Julian Bleecker's "blogjects," objects that report what
they are doing, in *Why Things Matter* (2006), which he calls an ancestor
of the spime [V]. Adam Greenfield's *Everyware* (2006), computing so
distributed the computer disappears [V]. Michael Grieves' "digital twin"
from product lifecycle management, early 2000s [T].

**After: the speculation became regulation.** This is the part that has
aged, in Sterling's favor.

| What | Status | Why it is a spime |
|------|--------|-------------------|
| EU Ecodesign for Sustainable Products Regulation, full application 19 July 2026; the central Digital Product Passport registry is live [V] | in force | Every regulated product gets a passport: identity, materials, history, end of life. A legal spime. |
| EU Battery Passport, mandatory for EV and industrial batteries over 2 kWh from 18 February 2027 [V] | firm deadline | First product category where the data trail is required to exist before the object may be sold. |
| GS1 EPCIS 2.0, ratified June 2022, ISO/IEC 19987:2024, JSON-LD, REST capture and query, sensor data [V] | adopted | The event language for "what happened to it": what, when, where, why, how. |
| GS1 Digital Link and Sunrise 2027: 2D codes replace 1D barcodes at retail by 31 December 2027; a global resolver routes a product's code to whatever the brand points it at [V] | rolling out | The physical object carries a web-resolvable identity. |
| Asset Administration Shell, IEC 63278-1:2023, the Industrie 4.0 digital twin standard with submodels for nameplate, technical data, energy, maintenance [V] | published | An industrial spime with a typed schema. |
| W3C Verifiable Credentials 2.0, Recommendation 15 May 2025; Decentralized Identifiers 1.1, Candidate Recommendation, not before April 2026; DID Resolution v1, Candidate Recommendation, not before September 2026 [V] | standard, and near-standard | Identity that does not depend on one registry, and claims about an object that a third party can check. |

Sterling's 2005 spime and the 2027 battery passport are the same object.

---

## 3. Anatomy of a spime, mapped onto the VPB

| Spime part | Sterling | EPCIS 2.0 term | VPB today (SPEC v0.3) | Status |
|------------|----------|----------------|-----------------------|--------|
| Unique identity | uniquely identifiable | EPC / GS1 key, expressible as a Digital Link URI | `id`, container-minted, opaque | present, format undecided |
| History | tracked through space and time | events: what, when, where, why, how | append-only log with seq and time | present |
| What | the object | epcList | `bit` on every event | present |
| When | time | eventTime | `time` from the container clock | present |
| Where | space | readPoint, bizLocation | `position` on `created` and `moved` only | partial: no container id, no frame |
| Why | business context | bizStep, disposition | none | missing |
| How | sensor data | sensorElementList | `emitted` carries the emission | present, unnamed as such |
| Who | wrangler | (source/destination parties) | none | missing |
| Assembly | | AssociationEvent, added in 2.0 for assembling parts [T] | `linked` / `unlinked` | present, and a direct match |
| Commissioning | fabricated | ObjectEvent, action ADD | `created` | present |
| Decommissioning | folded back | ObjectEvent, action DELETE | `destroyed` | present |
| Physical instance | the material instantiation | the tagged item | LED cube, RESEARCH.md option 13 | designed, not built |
| Wrangler | the human role | the capturing application | any renderer or adapter | present by construction |

Three cells say missing or partial. That is the gap between "object with
a log" and "spime": **where in what frame, why, and who**.

---

## 4. What the VPB is missing

**4.1 Identity has no format.** `vpb-1`, `vpb-2` is a counter. Two grids
mint the same ids. A spime id must be unique across every container it
will ever visit and ideally sortable by time of minting. Options:

- **ULID** or **UUID v7**: 128-bit, time-ordered, no coordination, one
  small dependency or a few lines [T]. Enough for the model.
- **GS1 Digital Link URI**: the right answer if a VPB ever labels a
  physical product; overkill for a voxel.
- **DID**: the right answer if bits need to carry verifiable claims across
  organizations; not yet a Recommendation [V]; not now.

Recommendation: UUID v7 by default, with `mintId` still injectable so tests
keep the readable counter.

**4.2 Where is relative to a grid that has no name.** `position` is a
cell in some container. When a bit moves between grids, or is exported to
Blender and re-imported, the log says "moved from (3,3,0) to (5,5,0)"
without saying in which world. EPCIS separates the read point from the
business location for the same reason. Add a `frame` (the container's own
id) to `created`, `moved`, and `destroyed`. Containers therefore need ids
too, minted the same way.

**4.3 Why and who are absent.** Every event should be able to say what
caused it and which wrangler did it: a carve tool, a replay, a physics
step, a person. EPCIS calls this bizStep and disposition, and names the
parties. Add optional `actor` and `cause` strings to the stamped event.
Optional, so the model stays cheap when nobody cares.

**4.4 No interchange format.** The log is an in-memory array. A spime's
data trail must leave the process. Two shapes already planned in ADR 0005,
snapshot and ledger, need a serialization. Proposal: the ledger's
interchange format is **EPCIS 2.0 JSON-LD**, through a sink that maps the
table in §3. Any supply chain tool that reads EPCIS then reads a VPB's
history. This is the cheapest way to make the spime claim testable from
outside the project.

**4.5 Retention is undecided (open question 5).** The 8×8×8 fill recorded
on the order of ten thousand `linked` events. The event sourcing
literature's standard answer is snapshot every N events, keep the last two
or three snapshots per aggregate, compact the rest [V]. CRDT systems face
the same growth from tombstones and compact on a schedule [V]. For the VPB:
a `SnapshotSink` that folds every N events into a snapshot and drops the
folded events, with N configurable, and `linked`/`unlinked` eligible for
dropping first because replay derives them (verified for one sequence in
Phase 1, not proven in general).

**4.6 Multi-wrangler history is out of scope, deliberately.** Two people
carving the same wall at once produce two logs that must merge. Automerge
and Yjs solve exactly this and keep full history by default [V]. Not
needed for a single-wrangler demo; noted so the event format does not
preclude it: events already carry a monotonic `seq` per container, which
is what a merge would key on.

---

## 5. Imaginative propositions

- **A passport for a virtual object.** The Battery Passport schema, applied
  to a bit: identity, composition (emission), history, current holder,
  end-of-life state. A VPB scene could emit a Digital Product Passport for
  each bit on request. Nothing in the regulation says the product must be
  physical.
- **The LED cube resolves.** Print a GS1 Digital Link QR on the physical
  cube from RESEARCH.md option 13. Scanning it opens that bit's live history
  on the Pages site. The physical thing and its data trail are joined by
  the standard the whole retail world is adopting by 2027.
- **Wrangler as a first-class role in the UI.** The scene editor, the
  replayer, the exporter, and the LED driver are wranglers. Show which one
  touched a bit last. That is the `actor` field made visible.
- **Recycling as a game mechanic.** A destroyed bit returns its emission
  to a pool that new bits draw from. Sterling's sustainability argument as
  a rule of the world rather than a metaphor.
- **A bit that outlives every renderer.** Export the ledger as EPCIS,
  delete the scene, re-import a year later into whatever renderer exists
  then. If the bit is the same bit, the spime claim holds.

---

## 6. Proposed SPEC v0.4 amendments

Proposals, each with its oracle. None is executed by this document.

| # | Amendment | Oracle |
|---|-----------|--------|
| 1 | Default `mintId` is UUID v7; containers also get an id. | 10,000 ids across 10 grids, no collisions, sorted order matches minting order. |
| 2 | `created`, `moved`, `destroyed` carry `frame`, the container id. | Replay of a log spanning two grids reconstructs both. |
| 3 | Stamped events gain optional `actor` and `cause`. | An `EpcisSink` writes bizStep from `cause` and a party from `actor`. |
| 4 | `EpcisSink` emits EPCIS 2.0 JSON-LD per the §3 mapping. | Output validates against the EPCIS 2.0 JSON schema; OpenEPCIS accepts a captured document. |
| 5 | `SnapshotSink` with snapshot-every-N and last-k retention; closes open question 5. | Replay from snapshot plus tail equals replay from the full log, for the Phase 1 carve sequence. |
| 6 | ADR 0005 wording: "gizmo," not "gadget." | Text matches the source. Done in this PR. |

Amendments 1 through 3 are model changes of a few dozen lines each.
Amendments 4 and 5 are sinks, outside the render path, per ADR 0005's
rule that history never enters `evaluate`.

---

## 7. Tools and repositories to consider

- **OpenEPCIS**: open-source, GS1-conformant EPCIS 2.0 implementation with
  a test data generator and JSON-LD docs [V]. The reference to validate
  amendment 4 against.
- **GS1 Conformant Resolver 1.2.0**, January 2026 [V]. For the LED cube
  proposition.
- **uuid** (npm) for v7, or **ulid** [T]. One line.
- **Automerge** or **Yjs** for multi-wrangler merging, later [V].
- **W3C DID and VC libraries** only if bits must carry claims across
  organizations [T].

---

## Sources

Sterling: [MIT Press](https://mitpress.mit.edu/9780262693264/shaping-things/),
[Wikipedia: Spime](https://en.wikipedia.org/wiki/Spime),
[Experientia summary](https://blog.experientia.com/shaping-things-by-bruce-sterling/),
[P2P Foundation](https://wiki.p2pfoundation.net/Spime).
Lineage: [Origin of the Internet of Things, Cambridge IfM](https://www.ifm.eng.cam.ac.uk/news/the-origin-of-the-internet-of-things/),
[Ashton, Smithsonian](https://www.smithsonianmag.com/innovation/kevin-ashton-describes-the-internet-of-things-180953749/),
[Bleecker, Why Things Matter](https://nearfuturelaboratory.com/essays/2006/a-manifesto-for-networked-objects/),
[Blogjects, P2P Foundation](https://wiki.p2pfoundation.net/Blogjects),
[Greenfield, Everyware](https://alistapart.com/article/everyware/).
Regulation: [European Commission, Digital Product Passport](https://single-market-economy.ec.europa.eu/single-market/digital-product-passport_en),
[DPP timeline 2026–2030](https://passportcraft.com/insights/dpp-timeline-2026-2030-every-deadline),
[Battery passport guide](https://passportcraft.com/insights/eu-battery-passport-guide),
[DPP deadlines](https://solvedpp.com/en/knowledge/dpp-deadlines/).
Standards: [GS1 EPCIS and CBV](https://www.gs1.org/standards/epcis),
[EPCIS 2.0 launch](https://www.gs1.org/docs/epcis/epcis_2-0_launch.pdf),
[OpenEPCIS docs](https://openepcis.io/docs/epcis/),
[GS1 Digital Link and Sunrise 2027](https://linkscan.org/blog/gs1-digital-link-sunrise-2027),
[GS1 Digital Link guide 2026](https://linkode.cl/en/gs1-digital-link/),
[IEC 63278-1:2023](https://webstore.iec.ch/en/publication/65628),
[AAS specification, IDTA](https://industrialdigitaltwin.org/wp-content/uploads/2025/03/IDTA-01001-3-0-2_SpecificationAssetAdministrationShell_Part1_Metamodel.pdf),
[W3C DID 1.1](https://www.w3.org/TR/did-1.1/),
[W3C DID Resolution](https://www.w3.org/TR/did-resolution/),
[W3C VC Overview](https://www.w3.org/TR/vc-overview/),
[W3C DID 1.1 candidate, Biometric Update](https://www.biometricupdate.com/202603/w3c-releases-updated-decentralized-identifiers-spec-for-comment).
Retention: [Event sourcing snapshots](https://www.eventsourcing.dev/first-principles/snapshots),
[Event sourcing guide 2026](https://dev.to/young_gao/event-sourcing-explained-when-crud-is-not-enough-4od5),
[Yjs vs Automerge 2026](https://kanopylabs.com/blog/yjs-vs-automerge-vs-liveblocks),
[CRDTs for mobile sync](https://mvpfactory.io/blog/crdts-for-offline-first-mobile-sync-automerge-vs-yjs-merge-semantics-and-the/).
