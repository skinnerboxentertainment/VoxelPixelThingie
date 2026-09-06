# VoxelPixelThingie, Program 4: Durable, Accessible, Capable

Plan v1, draft, 2026-09-06. Follows PLAN.md (Phases 0 to 5), the Phase 6
journal, PLAN-2.md (Phases 7 to 10), and PLAN-3.md (Phases 11 to 15, plus
Phase 16 in its journal and ADR 0011). Drawn from PUNCHLIST.md, which came
from one question: if the bit reached a thousand years out and could send
one request back to its inception, what would it ask to have bundled in.
Companion to SPEC.md v0.8, ADRs 0001 to 0011.

Labels: **[V]** verified by a source read or a probe run in this
repository on the date named. **[T]** trusted from prior knowledge or a
document. Everything here is a proposal; nothing in it has been executed.

Every decision below is written twice: in plain words first, then a
**Tech** line for whoever builds it.

---

## Objective, non-goals, assumptions, validation

**Objective.** Make the bit survive its makers and its hosts, be usable
by anyone, and carry its own rules: a reader that needs nothing installed,
seals that stay checkable after a key or a domain is gone, a policy the
bit enforces on itself, a memory it can search, senses from the physical
bit, releases anyone can rebuild and check, an interchange format other
tools already open, accessibility as a test, a conformance kit another
language can pass, and, only after four answers, a way to hold value.

**Non-goals.** No vendor as a dependency. No token of our own. No feature
that needs an account to test. No new renderer. No change to what a
VoxelPixelBit is (26 nodes, private, linked, self-culling, identified,
historied) or to the event vocabulary (ADR 0010 set the precedent: new
meaning arrives as reserved annotation keys, not new event types).

**Assumptions.**
- One engineer plus the review agents, the CONTRIBUTING.md ritual, tickets
  with oracles before branches.
- Standards over vendors, files over services (docs/research/
  compute-attachment.md, PUNCHLIST.md). Where a phase needs an outside
  party (a timestamp authority, a transparency log), it is one backend
  behind a contract whose reference runs in process.
- Hardware (#72, #73) and release 0.4.0 stay where they are: held for
  first light. Nothing here cuts a release.
- WebCrypto has Ed25519 in every engine [V: Chrome 137, Firefox 129,
  Safari 17; Igalia and IPFS Foundation write-ups read 2026-09-06], so a
  dependency-free page can verify a seal.
- The demo build is already reproducible: two consecutive `npm run build`
  runs produced 29 files with identical SHA-256s [V: probed 2026-09-06].

**Validation.** Each phase names an oracle that can fail, run in CI where
CI can reach it and recorded with the SHA in a journal where it cannot.
The program's closing oracle is the spime test one more step out: a
stranger with one file, no network, no Node, and no account opens the
reference scene, reads any bit's passport and history, and sees the seal
verify against the key the file carries and the time a witness attested.

---

## Standards carried forward

PLAN-2.md's three and PLAN-3.md's two stand. Three more:

- **A reader in the box.** Anything published as a scene is published
  with a way to open it that needs nothing else. If the reader cannot
  open it, it is not published.
- **Accessibility is an oracle, not a retrofit.** A new page ships with
  its audit in the ticket's oracle. Existing pages are retrofitted once,
  in Phase 24, and audited thereafter.
- **No account to test.** A phase whose oracle cannot run without someone
  signing up somewhere is not done; the account-needing path is a second
  backend and a Decision.

---

## Phase 17: The reader

Punchlist item 1.

**Today.** A pack (`vpb-scene-pack/1`) is one JSON file, but opening it
takes this repository, Node, and `npm ci`. The passport page needs the
demo build served. The SPEC lives in the repo, not with the scene.

**Oracle.**
- `npm run scene:reader -- <scene> <out.html>` writes one HTML file that
  contains the reader, the pack, the SPEC text, and the container's DID
  document. Opened from disk in a browser with the network off and Node
  absent, it lists the bits, shows any bit's passport and history, and
  reports the scene digest equal to `npm run scene:check` on the same
  scene.
- The file verifies the seal's signature against the embedded DID
  document and says "verified against the embedded document" (not
  "resolved"); with the network on it resolves the DID and says so.
- One byte changed in one ledger inside the file makes the reader name
  the bit and fail the check.
- The reader passes an axe audit with no critical or serious findings and
  is fully operable by keyboard (Phase 24's standard, applied from day
  one).
- The file is under 4 MB for the reference scene.

**Design.** In plain words: every published scene comes with its own
viewer baked into the same file, the way a PDF carries its fonts. Open it
anywhere, forever, and it shows what the bits are and proves nobody
changed them.

**Tech:** `demo/reader/` is a fourth page, no Three.js, no Pixi, no
QR dependency: a list, a passport panel, a history table, a verify
button. It imports `src/verify.ts`, `src/did.ts`, `src/keys.ts`, and
`src/pack.ts` so verification is the same code the repo runs. The build
inlines everything into one file (`vite-plugin-singlefile` 2.3.3 is on
npm [V: `npm view`, 2026-09-06]; it is a build-time dependency only).
`scripts/reader-scene.ts` takes the built page and injects the pack, the
SPEC text, and the DID document as `<script type="application/json">`
blocks; the page reads those first and falls back to `?scene=` URLs. The
pack format does not change; the reader is a wrapper around a `/1` pack
so every existing pack opens in it. ADR 0012 "A scene carries its own
reader".

**Work.**
1. `demo/reader/index.html` and `main.ts`; the page in the Vite inputs.
2. The single-file build and `scripts/reader-scene.ts` with the
   embedded-document verify path.
3. A Playwright test that opens the file from `file://` with
   `offline: true`, plus the tamper case; a Node test on the injected
   JSON blocks; the axe audit.
4. The reference scene's reader published beside its pack in the scenes
   repository; the passport page links to it.

**Exit review.** `falsifier` on "opens with nothing else": the
reproduction is a fresh user profile with no network.

**Risk.** `file://` origins restrict `fetch`; the reader must read its
embedded blocks from the DOM, never by URL. Browsers also differ on
`file://` module scripts, so the build inlines as a classic script.

---

## Phase 18: Seals that outlive their hosts

Punchlist item 2.

**Today.** A seal is signed with the container's key (Phase 11) and
verified by resolving a `did:web` document served from GitHub Pages.
`did:web` has no history and no rotation [V: W3C DID 1.1 is at Candidate
Recommendation, 2026-03-05, and the method note still says rotation is
unsupported; read 2026-09-06]. Take the page down or lose the key and the
seal becomes "unresolved" forever.

**Oracle.**
- A sealed scene carries a witness proof beside its signature; with the
  DID page removed, `npm run scene:check` still reports the seal was
  witnessed at a named time and by which witness, and the hashes hold.
- The container's key is rotated: a signed chain from the old key to the
  new one is published; a seal made with the old key verifies through the
  chain against the new DID document, and a seal made with the old key
  *after* its retirement time is reported as such.
- The reference notary (in process) and one public RFC 3161 timestamp
  authority both pass the same `Witness` conformance cases; the public
  one runs in CI only when reachable and is skipped with a reason
  otherwise.
- The Phase 17 reader shows the witness time next to the seal.

**Design.** In plain words: a seal is a signature; a witness is someone
else saying "I saw this signature at this time". With both, the scene
can still be trusted after the key is thrown away or the website
disappears, because the witness's word about the time stands on its own.
And when we change keys, the old key signs a note naming the new one, so
the old signatures are still ours.

**Tech:** `src/witness.ts`: a `Witness` contract, `attest(digest) →
proof`, `verify(proof, digest) → { time, witness }`. Reference backend: a
notary that is another Ed25519 key signing `{ digest, time }` (tests and
the twin). Second backend: RFC 3161 [V: the protocol; free public
authorities exist, and Sigstore runs one; read 2026-09-06], a
request/response client and a small DER walker sufficient to read the
token's `messageImprint`, `genTime`, and signer certificate, then verify
the CMS signature with WebCrypto (RSA PKCS#1 v1.5 or ECDSA). A
transparency log inclusion proof is a third backend, deferred to the
Decision below. Rotation: `src/did.ts` gains a `rotation` statement
(`{ from: kid, to: kid, retired: time }` signed by `from`), published as
`rotations.json` beside the DID document and pinned beside the pack;
`verifyScene` walks the chain and compares the witness time with
`retired`. The manifest's `signature` gains `witness`. SPEC v0.9 §10.3.
ADR 0013 "Seals are witnessed and keys rotate by chain".

**Work.**
1. `Witness` contract, the notary reference, conformance cases, manifest
   and SPEC changes.
2. The RFC 3161 backend and its verification; a recorded token in
   `tests/fixtures/` so verification is tested offline.
3. Rotation statements, `scripts/rotate-key.ts`, the chain walk in
   verify, the reader display.
4. Journal with the reference scene re-sealed, witnessed, and the DID
   page test done by pointing the resolver at a dead host.

**Exit review.** `/teachback` on what a witness proves and what it does
not (it proves "existed by", never "made by").

**Risk.** CMS parsing is where this phase's time goes; the DER walker
handles exactly the shapes the recorded fixtures contain and refuses
anything else, which is the honest scope.

---

## Phase 19: The policy the bit carries

Punchlist item 3.

**Today.** Any actor with the model can change any bit. `wrangle` records
who, but the SPEC says outright it is "a convenience for honest logs, not
a security boundary" (§9.6). Job records are validated at the sink
(§9.7); nothing else is.

**Oracle.**
- A bit whose passport carries a policy refusing agents is asked over MCP
  to emit; the tool returns an error naming the policy, the bit is
  unchanged, and the ledger holds a `policy:refused` record naming the
  actor and what was attempted.
- A policy that names allowed job kinds makes `request_job` for another
  kind fail its audit with the policy named, and no result is stored.
- A policy that names its controllers refuses `set_passport` from anyone
  else, including a replacement policy.
- A bit with no policy behaves exactly as today: the whole existing test
  suite passes unchanged.
- The conformance suite gains the cases; the scene digest holds across
  four stores with refusals in the ledger.

**Design.** In plain words: a bit can carry a small rulebook in its
passport saying who may change it, what work it will take, and whether a
software agent may act on it at all. The rulebook is enforced at the one
door every change goes through, and a refusal is written down like any
other event, so the history shows who was turned away.

**Tech:** a reserved passport key `policy` (SPEC §9.5 gains it beside
`ledMap`) with a fixed, small vocabulary: `controllers` (actors or DIDs
who may set the passport), `actors` (allow or deny lists, prefix
patterns such as `mcp:*`), `agents` (boolean, matching the `mcp:` and
`actor:` prefixes), `work` (allowed job kinds), `version`. Enforcement in
`SceneSink` and in `InProcessPool`/`performJob`, the two chokepoints;
the container itself stays policy-blind so the model does not change.
Refusal is an `annotated` event under `policy:refused` stamped with
actor `policy`, the refused actor and event type in the value. The
vocabulary maps one-to-one onto ODRL 2.2 terms (permission, prohibition,
assignee, action) so `scripts/export-policy.ts` can emit ODRL for anyone
who asks [V: ODRL 2.2 is a W3C Community Group specification, not on the
Recommendation track; read 2026-09-06], but the enforced form is ours and
fits in a hundred bytes. Capability tokens (UCAN, ZCAP) are the survey's
alternative for delegation across parties; deferred until there is a
second party [T]. ADR 0014 "Policy is a passport key the sink enforces".

**Work.**
1. `src/policy.ts`: schema, matching, the refusal record; sink and pool
   enforcement.
2. MCP surfaces the refusal as a tool error and a `get_policy` tool.
3. Conformance cases; SPEC v0.9 §9.5 and §9.8 "Policy"; ADR 0014.
4. The reference scene's origin bit gets a policy; the journal shows an
   agent refused.

**Exit review.** `big-bruiser` on "every change goes through the sink":
find a write path that skips it (compaction, replay, unpack).

**Risk.** Replay: events already in the ledger must never be re-judged,
or a tightened policy would break its own history. Replay stamps
`actor: "replay"` and the sink exempts it, and the test proves a
tightened policy replays.

---

## Phase 20: Searchable memory

Punchlist item 4.

**Today.** Reading a bit's history is a ledger scan. "When did anyone
touch slot 1" is a loop over every ledger in the scene, written by hand
each time.

**Oracle.**
- `search` over MCP answers "slot 1, any actor, any time" on the
  reference scene in one call with the bit, seq, actor, and time of each
  hit, in under 50 ms after the index is built.
- The index is a file beside the manifest, rebuilt from ledgers and
  passports alone; deleting it and rebuilding gives byte-identical
  output; a scene with a stale index detects it by manifest `seq`.
- Text search finds a cause ("carve tunnel") and a passport value
  ("origin"); structured search filters by bit, slot, actor, type, key,
  and time range; both compose.

**Design.** In plain words: the bit's memory gets a table of contents.
Anyone, including an agent, can ask a question about the history and get
an answer without reading every page.

**Tech:** `src/memory.ts`: an inverted index over event fields and
tokenized text (cause, annotation values, passport strings), no
dependency, serialized as `index.json` with the manifest `seq` it was
built at. Queries are a small object, not a language. A `Vectors`
contract slot (`embed(text) → number[]`) is declared with no reference
shipped; vectors need a model, and a local one is a dependency this
phase does not take [T]. MCP gains `search` and the durable worker
exposes the same over the actor contract as a `search` workload so an
agent can ask a bit about itself.

**Work.**
1. The index, the query object, the file with staleness detection.
2. `search` tool and workload; `scripts/scene-search.ts`.
3. Tests, including the timing on the reference scene.

**Exit review.** `/roast` on tokenization: what a passport value that is
not a string does to the index.

**Risk.** None that changes shape; this is the small one.

---

## Phase 21: Senses

Punchlist item 5.

**Today.** The physical bit is a strip that receives frames (ADR 0009).
Nothing flows the other way. The EPCIS export already writes
`sensorElementList` for emissions (`src/epcis.ts`), so the shape exists
with nothing real in it.

**Oracle.**
- The twin (`scripts/wled-sim.ts`) reports fake temperature and light
  readings in the `info.sensor` array of its JSON API, the shape WLED
  uses for usermod sensors [V: WLED JSON API docs, read 2026-09-06]; the
  bridge polls them and the bit's ledger gains `sense:temperature` and
  `sense:illuminance` annotations with value, unit, time, and device.
- The EPCIS export carries them as sensor reports with CBV measurement
  types and UN/CEFACT units (CEL, LUX) [V: EPCIS 2.0 / CBV 2.0 sensor
  vocabulary, read 2026-09-06]; the document validates against the EPCIS
  schema and the OpenEPCIS capture check accepts it.
- The scene digest holds across four stores with readings in the ledger;
  compaction keeps the last reading per quantity.
- Hardware half: when the physical bit exists (#72) with a temperature
  usermod [V: WLED ships a DS18B20 Temperature usermod], the same bridge
  path lands a real reading; recorded in the journal with the SHA.

**Design.** In plain words: the bit gets senses. What it feels (heat,
light, touch) is written into its own history with units, and exported
in the same supply-chain format the emissions already use, so any EPCIS
system reads it as a sensor event.

**Tech:** reserved annotation keys `sense:<quantity>` with a schema in
`src/senses.ts` (`{ value, uom, time, device?, min?, max? }`), validated
at the sink like job records. `src/epcis.ts` maps them to
`sensorReport { type: gs1:Temperature | gs1:Illuminance | ..., value,
uom, deviceID }` and `sensorMetadata { time, deviceID }`. The bridge
(`scripts/led-bridge.ts`) gains a poll interval and writes readings
through the sink with actor `device:<host>`. The twin gains
`--sensors`. Browser sensors (Generic Sensor API, Web Bluetooth) are a
second source behind the same annotation keys, deferred [T]. ADR 0015
"Senses are annotations with units".

**Work.**
1. `src/senses.ts`, sink validation, EPCIS mapping, capture check.
2. Twin sensors and bridge polling; a test that the twin's reading
   lands.
3. Compaction rule; SPEC v0.9 §9.9 "Senses"; ADR 0015.

**Exit review.** `claim-auditor` on the EPCIS mapping against the CBV
sensor vocabulary: every type and unit we emit is one the standard
names.

**Risk.** OpenEPCIS has bitten on every extension so far (journals 9 and
12); the capture check runs before the ticket closes, not after.

---

## Phase 22: Reproducible, attested releases

Punchlist item 6.

**Today.** Releases are release-please tags with a changelog. The demo
build is already deterministic [V: probed 2026-09-06], `npm sbom` emits
SPDX 2.3 from the lockfile [V: npm 10.9.3, probed 2026-09-06], and
nothing is signed or recorded anywhere.

**Oracle.**
- `npm run release:build` on two clean machines (CI's Linux runner and
  this Windows machine) from the same tag produces `dist/` with identical
  SHA-256s and a `release.json` manifest of them; the journal records
  both hash sets.
- `npm run release:attest` signs the manifest's digest with the
  container key (no account) and writes a witness proof (Phase 18); a
  CI workflow additionally attaches a build-provenance attestation on
  the public log; `npm run release:verify <tag>` checks whichever is
  present and reports the source (key, witness, provenance) for each.
- An SBOM (SPDX 2.3) is attached to every release and its package list
  matches `package-lock.json` exactly (a test diffs them).
- All of this runs against a pre-release tag; 0.4.0 stays held.

**Design.** In plain words: anyone can rebuild a release from its source
and get the very same bytes, see the list of everything inside it, and
check that the copy they have is the one we made. That is what lets
someone trust a build long after we are gone.

**Tech:** `scripts/release-build.ts` pins `SOURCE_DATE_EPOCH` to the
tag's commit time [V: reproducible-builds.org spec] and writes the
manifest; `scripts/release-attest.ts` signs with the Phase 11 key and
witnesses with Phase 18; a workflow step uses in-toto/SLSA provenance
through the host's attestation action, which records in the Sigstore
public-good log [V: GitHub artifact attestations use Fulcio, a TSA, and
Rekor; read 2026-09-06]. The provenance path is one backend, chosen
because it is where npm and most open source already record; a second
would be cosign keyless from any CI. The reference (key plus witness)
needs no account. ADR 0016 "Releases are reproducible and attested".

**Work.**
1. Release build with the manifest, SBOM, and the lockfile diff test.
2. Attest and verify scripts; the provenance step behind a Decision.
3. RELEASING.md and the journal with two machines' hashes.

**Exit review.** `falsifier` on "identical on two machines": the
reproduction is a fresh clone at the tag on the other OS.

**Risk.** The Vite build is deterministic today; a dependency bump can
break it silently, so the two-build comparison joins CI.

---

## Phase 23: glTF interchange

Punchlist item 7.

**Today.** A scene leaves the repo as a pack or as EPCIS. No 3D tool can
open it.

**Oracle.**
- `npm run scene:gltf` writes a glTF 2.0 `.glb` of the reference scene;
  it validates with the Khronos validator; it opens in Blender and in a
  web viewer with the bits in place and their emission visible.
- `npm run scene:gltf:import` reads it back: the spime test passes
  (ids, positions, emissions, passports, links, render flags equal); and
  with the default `--ledgers` on, the imported scene's digest equals
  the exported scene's, because the ledgers travel in the file.
- A file edited in Blender (one bit moved) imports as a scene whose only
  new event is that bit's `moved`, with actor `gltf:import`.

**Design.** In plain words: the scene can be saved in the 3D format that
Blender, game engines, and browsers already open, with each bit's name
and passport riding along inside, and read back without losing who the
bits are.

**Tech:** one node per bit (translation from position), one shared unit
cube mesh, one material per distinct bit color and light, `emissiveFactor`
from color scaled by light and `KHR_materials_emissive_strength` for
values over one [V: Khronos extension; Blender imports and exports it
since 3.3; read 2026-09-06]. Per-slot emissions and the bit id, passport,
and (optionally) ledger text go under the node's `extras`, which Blender
keeps as custom properties [T] and which glTF reserves for application
data. Six-primitive meshes for per-face color are a stretch. Import maps
`extras.id` back to the bit and, when ledgers are present, replays them
before applying differences. ADR 0017 "glTF is the interchange; extras
carry identity".

**Work.**
1. `src/gltf.ts` export with the validator in the test.
2. Import with the spime test and the digest test.
3. The Blender round trip recorded in the journal with a screenshot.

**Exit review.** `/intent-check`: the export adds no dependency; the
validator runs as a dev tool only.

**Risk.** Extras are not part of the seal; a glTF is a copy, not a
store. The reader and the pack stay the record; the ADR says so.

---

## Phase 24: Accessibility

Punchlist item 8.

**Today.** The passport page and the Three.js demo carry no ARIA
attributes [V: grep count zero, 2026-09-06]; the canvas is mouse-only;
there is no text rendering of a scene.

**Oracle.**
- The passport page, the Three.js demo, the canvas demo, and the reader
  pass `@axe-core/playwright` [V: 4.13.0 on npm, WCAG 2.2 rules;
  2026-09-06] with no critical or serious findings, in CI.
- A keyboard-only Playwright test opens the Three demo, moves the
  selection with arrow keys, opens a bit's passport with Enter, sets it,
  and removes the bit, never touching the mouse; the ledger names the
  same actor as the mouse path.
- `?view=text` renders any scene as an ordered list of bits with
  position, color, present state, and passport, readable top to bottom
  by a screen reader; the same view is what `scripts/scene-text.ts`
  prints in a terminal.
- `prefers-reduced-motion` stops the orbit autoplay and the HUD
  refreshes at 1 Hz.

**Design.** In plain words: everything a mouse can do, a keyboard can
do; everything the canvas shows, words can say; and a test checks it on
every change so it cannot quietly regress.

**Tech:** WCAG 2.2 [V: W3C Recommendation] as the bar, axe as the
automated part, the keyboard and text-view tests as the part axe cannot
see. Selection state moves into `demo/shared/view.ts` so mouse and
keyboard share one path. The text view is a `<section aria-live>` in
each page and a script in the terminal.

**Work.**
1. Passport page and reader: labels, focus order, live regions.
2. Three and canvas demos: keyboard selection, the text view, reduced
   motion.
3. The axe project in `playwright.config.ts` and the keyboard test.

**Exit review.** `/roast` from the point of view of a screen-reader user
opening the reference scene cold.

**Risk.** A WebGL canvas cannot be made accessible; only its controls
and its text twin can. The ADR-free scope note says exactly that.

---

## Phase 25: Language-neutral conformance kit

Punchlist item 9.

**Today.** The conformance suite is TypeScript (`tests/conformance/
container-suite.ts`) with the reference numbers in code. A second
implementation would have to read our tests to know what to match.

**Oracle.**
- `npm run conformance:export` writes `conformance/` fixtures: for each
  case, the operations as JSON, the expected normalized events, the
  expected digest, and the expected render flags per camera; the
  TypeScript suite is rewired to run *from* the fixtures and still
  passes, which proves the fixtures are complete.
- A second implementation in Python, `kit/python/`, passes tiers 1 and
  2 (replay a ledger and compute the digest; container operations and
  link derivation) and produces the reference scene's digest from its
  ledgers; tier 3 (render self-tests) is a stretch.
- The kit ships a `RUNNING.md` that a stranger can follow with only the
  fixtures and no TypeScript.

**Design.** In plain words: the rules for "what counts as a correct
bit" become a folder of examples with expected answers, in a form any
programming language can read. Then we prove it by writing a second,
small implementation in a different language and watching it pass.

**Tech:** fixtures as JSON with a `vpb-conformance/1` format field and
tiers; the seal and signature cases from Phase 11 and the witness cases
from Phase 18 are tier 1. Python is chosen for the second implementation
because it is the widest-reach language with no toolchain friction, and
it is a stranger's most likely first attempt [T]; it is not a
dependency of anything. ADR 0018 "The conformance kit is fixtures, not a
language".

**Work.**
1. The exporter and the rewired TypeScript runner.
2. The Python implementation, tiers 1 and 2, run in CI.
3. `RUNNING.md`, ADR 0018, the journal.

**Exit review.** `phase-examiner` against the kit itself: every fixture
has an answer that a wrong implementation would fail.

**Risk.** Two implementations drift. CI runs both against the same
fixtures on every change; the fixtures are the contract, neither
codebase is.

---

## Phase 26: Value, after the four answers

Punchlist item 10. Gated: no ticket is opened until the answers below
are recorded in an ADR.

**The four questions**, in plain words, each with its tech line:

1. **Bearer or claim?** Does the bit hold the value itself (whoever has
   the bit has the value) or hold a receipt that someone else honors?
   *Tech: a key-controlled asset on a public ledger versus a signed
   claim resolved by an issuer.*
2. **Who holds the spend key?** The person, the container, or the bit's
   own key. *Tech: which DID's verification method has a `capabilityInvocation`.*
3. **What travels with the cube?** When a bit moves containers, does the
   value follow the id, stay with the container, or need a hand-off
   event? *Tech: whether the vault reference is in the passport, the
   manifest, or a `value:transfer` annotation.*
4. **May an agent spend?** Never, only within a policy limit, or freely.
   *Tech: Phase 19's `policy.work` gains a `value` clause with a limit
   and a unit.*

**Oracle, once answered.** Two bits on the reference scene exchange test
value; both ledgers record it under reserved `value:` keys; the seal
verifies; the reader shows the balances; nothing real moved and no
account was opened.

**Design.** A `Vault` contract (`balance`, `transfer`, `prove`) with an
in-process reference (a signed claim ledger, no chain) and, only if the
answers point at bearer value, one public test-network backend chosen by
the survey, not by any wired-in provider. A legal read precedes the
ticket. ADR 0019 records the answers.

**Work.** Deferred until the ADR exists.

**Risk.** This is the item most likely to be cut, and cutting it costs
nothing else in the program; the reserved key prefix is all the earlier
phases need to leave room.

---

## Sequence and days

Order follows the punchlist's ranking except where a phase feeds a
later one: the reader (17) sets the accessible-page standard the
retrofit (24) applies; witnesses (18) are used by releases (22); policy
(19) is what value (26) would constrain; the kit (25) absorbs cases from
18, 19, and 21 and so runs after them.

| Day | Phase | Deliverable | Oracle |
|-----|-------|-------------|--------|
| 1 | 17 | reader page, single-file build, injection | opens offline, digest equal |
| 2 | 17 | embedded-document verify, tamper, axe, publish | tamper names the bit |
| 3 | 18 | witness contract, notary reference, manifest field | notary cases pass |
| 4 | 18 | RFC 3161 backend, DER walker, offline fixture | recorded token verifies |
| 5 | 18 | rotation chain, verify walk, reader shows time | old seal verifies through chain |
| 6 | 19 | policy schema, sink and pool enforcement | agent refused, refusal in ledger |
| 7 | 19 | MCP surface, conformance, SPEC §9.8, ADR 0014 | suite passes unchanged without policy |
| 8 | 20 | index, query object, `search` tool and workload | slot 1 query in one call |
| 9 | 21 | senses schema, EPCIS mapping, capture check | OpenEPCIS accepts |
| 10 | 21 | twin sensors, bridge polling, compaction rule | twin reading lands |
| 11 | 22 | release build, manifest, SBOM, lockfile diff | two machines identical |
| 12 | 22 | attest and verify, RELEASING.md | verify names each source |
| 13 | 23 | glTF export with validator | opens in Blender |
| 14 | 23 | import, spime and digest tests, journal | round trip keeps digest |
| 15 | 24 | passport page and reader labels, axe project | no serious findings |
| 16 | 24 | keyboard selection, text view, reduced motion | keyboard-only carve |
| 17 | 25 | fixture exporter, rewired TS runner | TS passes from fixtures |
| 18 | 25 | Python tiers 1 and 2 in CI | reference digest from Python |
| 19 | 25 | RUNNING.md, ADR 0018, program journal | a stranger's run recorded |
| gated | 26 | Vault contract and reference, after ADR 0019 | test value exchanged, seal holds |

Nineteen working days plus the gated phase. PLAN-3's ten days took one
calendar day; this program has one hardware wait (Phase 21's second
half, on #72) and no other lead time.

---

## Ticket seeds

Created only when a phase is started, so their oracles reflect what the
previous phase measured.

| # | Phase | Title |
|---|-------|-------|
| 17.1 | 17 | Reader page and the single-file scene |
| 17.2 | 17 | Embedded-document verify, tamper test, axe, published reader |
| 18.1 | 18 | `Witness` contract, notary reference, witnessed seals |
| 18.2 | 18 | RFC 3161 backend with offline verification |
| 18.3 | 18 | Key rotation statements and the chain walk |
| 19.1 | 19 | Policy key, sink and pool enforcement, refusal records |
| 19.2 | 19 | Policy over MCP, conformance cases, SPEC §9.8 |
| 20.1 | 20 | Memory index, `search` tool and workload |
| 21.1 | 21 | Sense annotations, EPCIS sensor reports, capture check |
| 21.2 | 21 | Twin sensors and bridge polling; hardware half on #72 |
| 22.1 | 22 | Reproducible release build, manifest, SBOM |
| 22.2 | 22 | Attest and verify; provenance behind the Decision |
| 23.1 | 23 | glTF export with validation |
| 23.2 | 23 | glTF import, spime and digest round trip |
| 24.1 | 24 | Passport page and reader accessibility, axe in CI |
| 24.2 | 24 | Keyboard selection, text view, reduced motion |
| 25.1 | 25 | Conformance fixtures and the rewired runner |
| 25.2 | 25 | Python implementation, tiers 1 and 2 |
| 25.3 | 25 | RUNNING.md, ADR 0018, program journal |
| 26.x | 26 | Opened only after ADR 0019 |

---

## Decisions that are Oscar's

Each in plain words, then the tech line.

- **Public witness or private only** (Phase 18). A public timestamp
  authority's token is a permanent record that a digest existed at a
  time; it names nothing else. *Tech: which RFC 3161 authority the CI
  path uses; the notary reference needs nobody.*
- **Transparency log** (Phases 18 and 22). Entries in a public log are
  permanent and visible to anyone; they make releases and seals
  checkable without us, at the price of being unremovable. *Tech: Rekor
  via the host's attestation action, or none.*
- **Which sensors** (Phase 21). The bill of materials for #72 gains a
  temperature probe and a light sensor if senses are wanted on the first
  physical bit; the twin does not need them. *Tech: a DS18B20 on a
  usermod build of WLED, and an ADC photoresistor.*
- **Blender on this machine** (Phase 23). The round trip needs it
  installed once; the validator alone does not. *Tech: Blender 4.x with
  the bundled glTF add-on.*
- **Python as the second language** (Phase 25). Recommended above; any
  other choice is fine and changes nothing else. *Tech: 3.12+, no
  dependencies beyond the standard library.*
- **The four value questions** (Phase 26), and the legal read before
  any of it.
- **Any account, any spend.** The plan needs none; every account-needing
  path above is a second backend.

---

## Sources consulted

PUNCHLIST.md; docs/research/compute-attachment.md; the Phase 11, 12, 15,
and 16 journals; SPEC.md v0.8 §9.5 to §10.9; probes on this machine on
2026-09-06 (two builds byte-identical; `npm sbom` SPDX 2.3 on npm 10.9.3;
`npm view` for `@axe-core/playwright` 4.13.0 and `vite-plugin-singlefile`
2.3.3; grep for ARIA attributes in the demo pages). Web reads the same
day: Igalia and IPFS Foundation on Ed25519 in WebCrypto; W3C DIDs v1.1
Candidate Recommendation and the did:web method note; RFC 3161 and the
free authorities list; GitHub artifact attestations and Sigstore; the
Khronos `KHR_materials_emissive_strength` README and Blender's glTF
manual; Playwright's accessibility-testing page and Deque on axe-core
WCAG 2.2; GS1 EPCIS/CBV 2.0 sensor vocabulary; WLED's JSON API and
Temperature usermod; reproducible-builds.org on `SOURCE_DATE_EPOCH`; the
ODRL 2.2 information model and the UCAN specification repository.
