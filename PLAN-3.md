# VoxelPixelThingie, Program 3: Identity, Work, Attachment

Plan v1, draft, 2026-09-06. Follows PLAN.md (Phases 0 to 5), the Phase 6
journal, and PLAN-2.md (Phases 7 to 10). Drawn from
docs/research/compute-attachment.md, the field survey that precedes it.
Companion to SPEC.md v0.6, ADRs 0001 to 0009.

Labels: **[V]** verified by a source read on the date named or by a
measurement in this repository's journals. **[T]** trusted from prior
knowledge. Everything here is a proposal; nothing in it has been executed.

---

## Objective, non-goals, assumptions, validation

**Objective.** Make a bit a unit that compute and storage can attach to,
in the field's own terms: an identity strangers can verify, work recorded
as events with an audit, state that outlives any host, a contract for
compute with an in-process reference and one durable backend, and an
agent interface that is a standard rather than a vendor.

**Non-goals.** No token, no chain, no marketplace: there is no stranger to
pay yet. No new renderer. No change to what a VoxelPixelBit is: 26 nodes,
private, linked, self-culling, identified, and historied. No dedicated
machine per bit; the unit is the identity, compute is pooled per job.

**Assumptions.**
- One engineer plus the review agents, the CONTRIBUTING.md ritual.
- Contracts before vendors. Every backend in this program is
  interchangeable behind a contract, and the reference implementation of
  each contract runs in process with no account, the way `Grid` preceded
  `FlatGrid` and the WLED twin preceded the strip.
- Docker is available (Phase 9 used it); the one hosted service this
  program needs, a durable-execution engine, has an open-source dev
  server that runs locally [T].
- Nothing reachable through work accounts is used, by rule
  (docs/research/compute-attachment.md).

**Validation.** Each phase has a named oracle that can fail, run in CI
where CI can reach it and recorded with the SHA in the journal where it
cannot. The program's closing oracle is the spime test extended: a
stranger, given only a content address and a DID, verifies a bit's
history, its jobs, and their audits, with nothing of ours running.

---

## Standards carried forward

PLAN-2.md's three additions stand. Two more, from Phases 9 and 10:

- A metric is named for what it excludes (click→terminal-write, not
  click→photon). A number that cannot be measured is not reported under
  a name that says it was.
- A research track surveys the whole field and ranks by adoption and
  substance to hype before any vendor is named; the vendor is a backend
  behind a contract, never the contract.

---

## Phase 11: Identity with recourse

**Today.** A bit is a UUID v7 and a web URI under the project namespace
(ADR 0008). A scene's seal is a digest that holds across four stores
(§10.9), but it is trustworthy only if you trust the store: nothing is
signed, and no key belongs to a container.

**Oracle.**
- A container has a `did:web` document, served over HTTPS, naming its
  public key; the seal of the reference scene is signed with that key;
  `npm run scene:check` verifies the signature from the IPFS copy alone,
  resolving the DID and nothing else of ours.
- Tampering with one byte of one ledger in the packed copy fails the
  check with the bit named.
- Stretch: the signed seal is registered in a public transparency log and
  the check reads the inclusion proof [V: Sigstore's Rekor holds over 101
  million entries; SCITT is at architecture draft 22, 2026-09-06].

**Design.** Ed25519 keys through WebCrypto in the browser and `node:crypto`
in Node, one key per container, private key in the store's owner's
keeping, never in a passport. `did:web` per container:
`did:web:<host>:<path>:frame:<container id>`, resolving to a DID document
with a verification method and service endpoints for the manifest, the
passport page, and the EPCIS export. A bit's identity stays its web URI;
its DID is the container's DID plus a path, derivable, so 512 bits do not
need 512 files. The seal gains `signature` and `did` fields; `sealScene`
signs, `verifyScene` verifies when a DID is present and says so when it is
not.

**Work.**
1. `src/keys.ts`: key generation, sign, verify, JWK import and export,
   the same bytes in Node and the browser (a unit test asserts it).
2. `src/did.ts`: build and resolve `did:web` documents; a `FetchStore`
   resolver for the Pages host.
3. Seal and verify with signatures; `scripts/mirror-check.ts` reports
   signed, unsigned, or forged.
4. Publish the reference container's DID document where it resolves
   (see Decisions).
5. Stretch: `scripts/seal-register.ts` for the transparency log.

**Exit review.** `falsifier` on the claim "a stranger can verify from the
IPFS copy alone": the reproduction must use only public URLs.

**Risk.** `did:web` depends on a domain staying up; the mitigation is
that the DID document is also pinned beside the pack, and the check
accepts either.

---

## Phase 12: Work, audit, reward as events

**Today.** Events record what happened to a bit and who caused it. There
is no vocabulary for work a bit asks for, and no place for a result
larger than a passport.

**Oracle.**
- A job requested on the reference bit produces three events in its
  ledger: request, result carrying a content identifier, and audit naming
  the check that passed; the scene digest holds across four stores with
  them; the EPCIS export shows all three as observations with
  `vpb:job` sensor reports and the capture check accepts them.
- The result's content identifier resolves from two storage backends to
  the same bytes.
- Fifty jobs on fifty bits through the in-process reference actor: every
  bit's ledger ends with an audit; a job whose check fails leaves a
  failed audit and no reward event.

**Design.** No new event types. Job records are `annotated` events under
reserved keys `job:request`, `job:result`, `job:audit`, with a schema in
`src/jobs.ts` and validation at the sink. The reward is the audit that
passed; a wrangler may also record `job:reward` with whatever it means
by that, and the model does not care. Two contracts:

- `Storage`: `put(bytes) → cid`, `get(cid) → bytes`. Reference: an
  in-memory and a folder backend keyed by CID (SHA-256 multihash, the
  IPFS convention). Second backend: any S3-compatible object store [T:
  the de facto API], and the existing Pinata pin path for pack-sized
  results.
- `Actor`: one per bit id, `handle(job) → result`, holding the bit's
  replayed state. Reference: an in-process pool over `FlatGrid`. Backends
  arrive in Phase 15.

The first workloads are the project's own: render the bit's LED frame,
compute its EPCIS document, verify its neighbor links. Each has a check
that could fail, which is what makes it an audit.

**Work.**
1. `src/jobs.ts`: the three records, validation, `epcis.ts` mapping.
2. `src/storage.ts`: the contract, the memory and folder backends, CIDs.
3. `src/actor.ts`: the contract and the in-process reference pool.
4. `scripts/job-drive.ts`: request a job for a bit, wait, print the audit.
5. SPEC v0.7 §9.7 "Work", ADR 0010 "Work is recorded, audited, then
   rewarded, in that order".

**Exit review.** `claim-auditor` on SPEC §9.7 against `src/jobs.ts`.

**Risk.** Key-prefixed annotations are a convention, not a type; the
validation at the sink is what keeps them honest, and the conformance
suite gains the cases.

---

## Phase 13: Local first

**Today.** The Three.js demo runs on WebGPU [V: default in Chrome, Safari
26, Firefox 141 and later, Edge, 2026-09-06], but every computation a bit
does happens on the CPU.

**Oracle.**
- The LED frame for a bit, computed by a WebGPU compute shader, is
  byte-equal to `ledFrame` for a hundred random bits and emissions.
- The demo runs the whole reference scene's LED frames on the GPU in one
  dispatch; the HUD reports dispatch time; the e2e asserts equality on
  the mirrored bit's frame.
- A bit's `job:request` with `where: "local"` runs in the browser through
  the same `Actor` contract and lands the same three events.

**Design.** `demo/shared/gpu-jobs.ts`: a WGSL kernel per workload, the
LED frame first, an `Actor` backend that dispatches it. The audit is the
CPU path; a GPU result that differs fails its audit, which is the point.

**Work.**
1. The LED frame kernel and its byte-equality test in Playwright.
2. The local `Actor` backend and the demo's job panel.
3. Bench: dispatch time at 8³ and 16³ in `bench/`.

**Exit review.** `/roast` on the WGSL: precision and rounding at the
light multiply, where CPU and GPU disagree first.

**Risk.** Rounding. `Math.round` on the CPU and WGSL `round` differ at
.5; the kernel matches the CPU's rule, and the test includes the values
that sit on it.

---

## Phase 14: The scene as an MCP server

**Today.** An agent that wants to read or change a bit has to import the
library. There is no standard surface.

**Oracle.**
- `npm run mcp` serves a scene over the Model Context Protocol [V:
  donated to the Linux Foundation's Agentic AI Foundation, December
  2025; about 97 million monthly SDK downloads by March 2026]; an MCP
  client from the reference SDK lists tools and resources, reads the
  reference bit's passport and history, requests a job, and reads the
  audit back, all in a unit test with no vendor involved.
- The server's resources include SPEC.md sections, ADRs, and the oracle
  list, so an attached agent can orient in one read (the Radoff library's
  "machine-readable docs first").
- Claude Code attached to the server carves a bit and the change appears
  in the ledger with `actor: "mcp:<client>"`; recorded in the journal.

**Design.** `scripts/mcp-server.ts` on the official TypeScript SDK.
Tools: `list_bits`, `get_bit`, `get_history`, `emit`, `set_passport`,
`remove_bit`, `request_job`, `get_audit`. Resources: `spec://`, `adr://`,
`oracles://`, `scene://manifest`. Every tool call goes through
`grid.wrangle` with the client's name as actor, so the ledger records the
agent as it records a person.

**Work.**
1. The server, the tool schemas, the resource index built from the docs.
2. The SDK-client round-trip test.
3. A `.mcp.json` for the repo and a README paragraph.

**Exit review.** `big-bruiser` on the tool schemas: every tool either
mutates through the model's own API or reads; no side door.

**Risk.** The SDK moves fast [T]; pin it, and let Dependabot propose.

---

## Phase 15: One durable backend, the twin named

**Today.** The `Actor` contract has an in-process reference and a local
GPU backend. Nothing survives the process.

**Oracle.**
- The `Actor` contract passes the same conformance cases against a
  durable-execution backend run locally with no account [T: the
  top-ranked engine ships an open-source dev server]: 512 actors replay
  their ledgers and answer a job each.
- Kill the worker mid-job; after restart the job completes exactly once
  and the ledger shows one request, one result, one audit.
- The simulator is documented as the physical bit's digital twin in the
  original sense [V: the Radoff space episode's definition], and the
  Phase 10 journal's numbers are cited under that name.

**Design.** A backend module per engine, chosen by the survey's ranking
and never by what is wired into a session; the first is whichever
top-tier engine runs locally under Docker with an MIT license. A hosted
backend, if any, is a Decision below.

**Work.**
1. `src/actor-durable.ts` behind the contract; the conformance cases.
2. The kill-and-restart test as a script with the numbers in the journal.
3. Docs: the twin, and the docs index the MCP server serves.

**Exit review.** `/teachback` on exactly-once: what the engine guarantees,
what the ledger guarantees, and where the two meet.

**Risk.** Exactly-once is a claim engines make with conditions; the test
names the conditions it relied on.

---

## Sequence and days

| Day | Phase | Deliverable | Oracle |
|-----|-------|-------------|--------|
| 1 | 11 | keys, DID documents, signed seal | verify from the IPFS copy alone |
| 2 | 11 | published DID, forged-byte test, transparency stretch | tamper fails with the bit named |
| 3 | 12 | job records, storage contract and two backends | CID resolves from both |
| 4 | 12 | reference actor, job-drive, SPEC v0.7, ADR 0010 | fifty jobs, fifty audits |
| 5 | 13 | LED frame kernel, byte-equality | 100 random bits equal |
| 6 | 13 | local actor backend, job panel, bench | dispatch time recorded |
| 7 | 14 | MCP server, SDK round trip | tools and resources read back |
| 8 | 14 | docs resources, Claude Code attach, journal | actor recorded as `mcp:` |
| 9 | 15 | durable backend, conformance | 512 actors answer |
| 10 | 15 | kill-and-restart, twin docs, journal | exactly one of each event |

Ten working days, the same shape as PLAN-2.md, which took one calendar
day in practice; this program has no hardware lead time.

---

## Ticket seeds

Created only when a phase is started, so their oracles reflect what the
previous phase measured.

| # | Phase | Title |
|---|-------|-------|
| 11.1 | 11 | Container keys, `did:web` documents, signed seals |
| 11.2 | 11 | Publish the reference DID; forged-byte check; transparency-log stretch |
| 12.1 | 12 | Job records as reserved annotations; storage contract with CIDs |
| 12.2 | 12 | Actor contract with the in-process reference; job-drive; SPEC v0.7 |
| 13.1 | 13 | WebGPU LED frame kernel, byte-equal to the CPU |
| 13.2 | 13 | Local actor backend and the demo's job panel |
| 14.1 | 14 | The scene as an MCP server with the SDK round trip |
| 14.2 | 14 | Docs as MCP resources; Claude Code attached; journal |
| 15.1 | 15 | Durable backend behind the actor contract |
| 15.2 | 15 | Kill-and-restart test; the twin named; program journal |

---

## Decisions that are Oscar's

- Where the reference DID document is served: enabling GitHub Pages on
  the scenes repository, or a folder under the main site's `ns/` path.
- Whether to register seals in a public transparency log: entries there
  are permanent and public.
- Whether any hosted backend or account is opened for Phase 15, and any
  spend at all; the plan needs none.
- Whether a token layer is ever wanted; this program assumes not.

---

## Sources consulted

docs/research/compute-attachment.md and the sources it lists, read
2026-09-06; the Radoff livestream library, local copy, same day; the
Phase 6, 9, and 10 journals for the numbers the oracles extend.
