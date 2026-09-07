# VoxelPixelThingie, Program 5: One core, every host; programs the bit carries; the swarm

Plan v2, draft, 2026-09-06. Follows PLAN-4.md (Phases 17 to 25). Drawn
from PUNCHLIST-2.md items 6, 11, and 12. Companion to SPEC.md v0.9, ADRs
0001 to 0018, and the conformance kit in `conformance/`. Version 1 of this
plan covered item 6 alone; version 2 adds what Oscar asked on the same
evening: an executor inside the thing, so a bit can carry and run a
program of its own, and many bits can run theirs together as an
organized swarm. The atom does not change. The bit is still the atom.

Labels: **[V]** verified by a source read or a probe on this machine on
the date named. **[T]** trusted from prior knowledge. Everything here is a
proposal; nothing in it has been executed.

Every decision is written twice: in plain words first, then a **Tech**
line for whoever builds it.

---

## Objective, non-goals, assumptions, validation

**Objective.** Three things, in order, each standing on the one before.
First, move the rules of the bit out of a language and into an
artifact: one WebAssembly module, written in Rust, holding the slot
tables, the container, event stamping and replay, the canonical state
and its digests, the seal, and the render self-tests, the same bytes in
the browser, in Node, and from Python. Second, give the bit an executor:
a bit may carry a small sealed program, stored by content id, and ask
for it to be run in a box that can only compute; the result, the audit,
and the program's hash land in the ledger like any other work. Third,
let many bits run their programs together in rounds, each program seeing
only its own bit and what its neighbors say, so that organized behavior
emerges from local rules, deterministically, on every host, with every
change written down.

**Non-goals.** No change to what a bit is: 26 nodes, private, linked,
self-culling, identified, historied. No new event types; programs
produce the events that exist. No program may change any bit but its
own, or read any state but its own and its neighbors' emissions; the
ownership model (ADR 0001) is the sandbox's shape. No program runs
unless a policy allows it; default off. No program runs in the reader
without the reader's user saying so. No stores, witnesses, DID
resolution, MCP, renderers, or WebGPU inside the module. No vendor, no
account. No physical swarm in this program: the physical bit has not
been built, and one is not a swarm.

**Assumptions.**
- One engineer plus the review agents, the CONTRIBUTING.md ritual,
  tickets with oracles before branches.
- The conformance kit is the contract. The module is built against
  `conformance/` from the first commit and replaces nothing until every
  case passes; the executor and the swarm add fixtures of their own.
- The channel the swarm needs already exists. SPEC §3.2 defines
  `Emission.data` as "what it says to the network", and §9.5 keeps it
  distinct from the passport [V: SPEC.md 2026-09-06]. A program that
  speaks to its neighbors speaks through the node that faces them.
- The model's TypeScript is about 2,400 lines across nine files [V:
  `wc -l` 2026-09-06], and the render self-tests use only addition,
  multiplication, division, square root, and one comparison against
  `FACING_EPSILON = 1e-4` [V], which WebAssembly evaluates identically
  on every host [T: the core specification's IEEE 754 semantics].
- The toolchain is installed and proven on this machine, with Oscar's
  go-ahead on 2026-09-06 [V]: rustup 1.29.1, cargo 1.98.1 on the MSVC
  host, targets `wasm32-unknown-unknown` and `wasm32-wasip2`,
  wasmtime-py 48.0.0, wasm-tools 1.258.0, cargo-component 0.21.1. A
  smoke crate at `core/` with `sha2` and `ed25519-dalek` compiles
  natively (tests pass) and to a 36.8 KB module that Node 22 and Python
  both load and call with the same result [V].
- Every host already contains an executor: browsers and Node run
  WebAssembly natively [V], wasmtime runs it from Python and can meter
  fuel and cap memory [T]. Embedding an engine means using the one that
  is there.
- Hosts exist for components in the field: jco transpiles them for the
  browser, wasmtime-py loads them [V: Bytecode Alliance docs, read
  2026-09-06]; the core needs no system interface, only arithmetic and
  memory.

**Validation.** Each phase names an oracle that can fail, run in CI
where CI can reach it. The program's closing oracle: a swarm program
carried by every bit of the reference scene runs a fixed number of
rounds in Node, in the browser, and from Python, and the state digest
after the last round is the same in all three; every change of every
round is in the ledger under the program's hash; a policy without
programs stops the swarm before its first round; a runaway program is
stopped by its budget with the audit saying so.

---

## Standards carried forward

PLAN-4.md's three stand (a reader in the box; accessibility is an
oracle; no account to test). Three more:

- **The fixtures are the contract, neither codebase is.** A behavior
  change lands as a fixture first, then in the module, then in any host.
- **Determinism is enforced, not assumed.** The crate refuses at build
  time any floating-point operation the WebAssembly core cannot compute
  bit-identically, and a program's box has no clock, no randomness, and
  no imports. Two runs that differ are a failed audit.
- **Locality is the sandbox.** A program acts only on its own bit and
  speaks only through its own nodes. What a neighbor does with what it
  hears is the neighbor's program's business. This is ADR 0001 applied
  to behavior.

---

## The shape of a program, and of a swarm

In plain words: a program is a sealed box of arithmetic that a bit
keeps in its pocket, named by its fingerprint. When asked, the bit hands
the box a card with its own state and what its neighbors are saying,
and the box hands back a card saying what the bit should now emit and
note. The bit applies that through its normal door, so the policy and
the ledger see it like any other change. A swarm is many bits doing this
in step: everyone reads the cards at the same moment, everyone answers,
then everyone applies, so the order of bits never matters and the result
is the same on every machine. Organization comes from what the bits say
to each other, one face at a time, and from a conductor that decides
when the next round begins.

**Tech.** A program is a WebAssembly module with no imports, one
exported `run`, and a text ABI over linear memory (JSON in, JSON out;
the Component Model's string types once the hosts speak it). Input:
`{ bit: BitRecord, neighbors: { slot: { id, data } }, round, params }`.
Output: `{ ops: [ { emit, slot, emission } | { annotate, key, value } |
{ passport } ], say?: JSON }`, applied under actor `program:<cid>` with
cause `round:<n>` (or `job:<id>` outside a swarm). The executor is the
existing actor pool: a workload `program` whose `job:request.params`
names the module by CID in `Storage`; the pool fetches, instantiates,
meters (fuel and memory in wasmtime; a worker with a timeout in the
browser), runs, and records. The audit is re-execution: the same input
must give the same output, and every op must pass the sink. A swarm
round is `runAll` over the present bits with the same `program` job and
a shared `round` parameter, inputs snapshotted before any op is applied
(synchronous update). Carried programs live in the passport under a
reserved key `programs: [{ cid, sha256, role? }]`, and a policy's `work`
must include `program` (or a specific CID) for any of it to run.

---

## Phase 27: The core, native, tiers 1 and 2

**Today.** The rules exist as TypeScript, with a hand-written Python
second implementation for tiers 1 and 2 (`kit/python/vpb.py`).

**Oracle.**
- `cargo test` in `core/` runs every tier 1 and tier 2 fixture from
  `conformance/` and passes: the state, the state digest, the events
  under the fixed clock, the link counts, the seal's hash verdicts, and
  the signature verdicts.
- The determinism lint passes: no `f64` method outside a named allow
  list appears in the crate.
- A fixture with one expected byte changed fails, with the case named.

**Design.** In plain words: write the cube's rules a third time, but
this time against the folder of examples from the first line, and in a
language that compiles to the box. Do not touch WebAssembly yet; get the
rules right on a normal computer first.

**Tech:** a Rust crate at `core/` with modules `slots`, `grid`
(FlatGrid's semantics), `events` (stamping, the wrangler context,
report-then-apply), `replay`, `canon` (canonical JSON with JavaScript's
number formatting), `digest` (SHA-256 via `sha2`), `seal` (seal text,
per-file hashes, Ed25519 via `ed25519-dalek`). Tests read the fixtures
directly, the way `run_kit.py` does.

**Work.**
1. The crate, the slot tables, the container, events, replay.
2. Canonical JSON and the state digest; the tier 2 fixtures green.
3. Seal hashes and Ed25519; the tier 1 fixtures green; the lint.

**Exit review.** `falsifier` on "the canonical JSON is byte-equal to
JavaScript's": a fixture of hostile numbers (1e21, 1e-7, 0.1 + 0.2,
negative zero) added to tier 2.

**Risk.** Number formatting is where two languages disagree first; the
hostile-number fixture exists before the formatter is declared done.

---

## Phase 28: Tier 3 in the core

**Today.** The render self-tests (§8) and the render list are TypeScript
only; Python skips tier 3 by design.

**Oracle.**
- `cargo test` passes every tier 3 fixture: `renderCycle` and
  `renderEnabled` per bit for each camera, and the scene digest.
- The determinism lint still passes with the self-tests in the crate.
- `cameraMoved` (incremental) agrees with a full `evaluate` before and
  after a removal; a shuffled visiting order gives the same flags.

**Design.** In plain words: move the cube's "should I draw myself"
decisions into the box. They must be bit-identical everywhere, and they
can be, because they need no fancy arithmetic.

**Tech:** `render` module: presence, enclosure, coverage, facing, the
awake set, static-dirty and camera-dirty reruns, `renderList`;
`sceneCanonical` adds `links`, `renderCycle`, `renderEnabled` in the
kit's key order.

**Work.**
1. The self-tests and the dirty tracking.
2. The render list and the scene digest; tier 3 green natively.
3. Three more cameras added to the fixtures, including one edge-on.

**Exit review.** `/roast` on the facing test's edge cases.

**Risk.** Order of evaluation; the shuffled-order test is the answer.

---

## Phase 29: The module and its three hosts

**Today.** The crate runs natively. Nothing runs it in a browser, in
Node, or from Python.

**Oracle.**
- The same `core.wasm` passes all three tiers in Node, in Chromium
  (Playwright), and from Python (`run_kit.py --core core.wasm`); Python
  reports tier 3 as passed, not skipped.
- Two builds of the same commit, here and on CI's Linux runner, give
  byte-identical `core.wasm`; its SHA-256 is in the release manifest
  under a `core` tree.
- Size under the budget (proposed 400 KB; the smoke module is 36.8 KB).
  Speed: replaying the 8³ reference scene through the module is no
  slower than the TypeScript, measured and written down.

**Design.** In plain words: seal the rules into the box and prove the
box gives the same answers on all three kinds of computer. Talk to the
box in whole jobs, never in a chatter of small calls.

**Tech:** `wasm32-unknown-unknown` for the core module; a component via
`cargo-component` with `core/wit/vpb.wit` for hosts that speak the
Component Model; jco for the browser, wasmtime-py for Python. A
batch-shaped text interface: `open(pack)`, `replay(events)`,
`apply(ops)`, `state()`, `state_digest()`, `evaluate(camera)`,
`scene_digest(camera)`, `render_list()`, `verify(pack, did_document)`.
Hosts: `src/core.ts`, `kit/python/run_kit.py --core`. CI gains a `core`
job; `release:build` gains the `core` tree.

**Work.**
1. The WIT interface and the wasm build; the Node host; tiers 1 to 3.
2. The browser host under Playwright; the Python host; the CI job.
3. Size and speed measured; the release manifest's `core` tree; journal.

**Exit review.** `big-bruiser` on the interface: no host reaches model
state except through the named calls; nothing crosses but text and
numbers.

**Risk.** Host-to-module crossings cost per call; the batch interface is
the answer, the speed oracle the proof.

---

## Phase 30: Programs the bit carries

**Today.** Work is a fixed menu of workloads in the repository. A bit
cannot carry code.

**Oracle.**
- A program stored by CID runs as a job on a bit: request, result,
  audit, reward land; the request names the module's hash; the ops the
  program returned are applied through the sink under actor
  `program:<cid>`.
- The audit is re-execution: a program whose second run differs (one
  that reads uninitialized memory, in the fixture) fails its audit and
  leaves no reward; a program whose op the policy refuses fails its
  audit with the rule named.
- A bit whose policy lacks `program` refuses the request as a failed
  audit; a policy naming a different CID refuses this one.
- A program that never halts is stopped by its fuel budget in Node and
  Python and by its worker's timeout in the browser; the audit says
  "budget exceeded".
- A program that tries to act on another bit's id is refused by the
  executor before the sink sees it.
- The same program with the same input gives the same output in all
  three hosts.

**Design.** In plain words: give the bit a pocket for a sealed box of
arithmetic and a rule for when it may open it. The box can only compute;
it cannot see files, the network, a clock, or dice. What it answers goes
through the bit's normal door, so nothing changes about how a change is
judged or recorded.

**Tech:** `program` workload in `src/actor.ts` and `scripts/durable/`:
fetch bytes by CID from `Storage`, verify the CID against the bytes,
instantiate with no imports, call `run` over the text ABI, parse the
ops, filter to the bit's own id, apply under `program:<cid>`. wasmtime
fuel and memory caps in Node and Python; a Web Worker with `terminate()`
in the browser. Reserved passport key `programs: [{ cid, sha256, role? }]`
validated at the sink; policy `work` gains `program` and CID patterns
(`program:<cid>`). A first program, written in Rust in `programs/`,
"blink": emit amber on the face the params name; a second, "echo":
say back what a neighbor said. Stretch: programs carried as WebAssembly
text and assembled on load with `wasm-tools` compiled to WebAssembly, so
a passport can hold readable behavior [T: the tool builds to wasm].

**Work.**
1. The workload, the ABI, the executor with limits; "blink" and "echo".
2. The passport key, the policy vocabulary, the re-execution audit.
3. The browser and durable hosts; fixtures for the kit; SPEC §9.10
   "Programs"; ADR 0019.

**Exit review.** `big-bruiser` on the sandbox: find a way for a program
to read or change what is not its own, or to run without a policy.

**Risk.** Carried code is the first thing in the model a stranger could
plant. Default off, hash-named, policy-gated, sink-judged, and never run
by the reader without consent: five doors, each with a test.

---

## Phase 31: The swarm

**Today.** Bits are independent. Work runs one bit at a time or many
bits with no relation between their jobs.

**Oracle.**
- A round runs the same program on every present bit of the reference
  scene with inputs snapshotted before any op is applied; the state
  digest after 20 rounds is identical in Node, in the browser, and from
  Python, and identical when the bits are visited in a shuffled order.
- Three swarm programs behave as their fixtures say: "wave" (a lit
  front travels one bit per round from a seed and dies at the edge),
  "gradient" (each bit settles to the mean of what its neighbors say,
  converging to a fixed digest), "count" (bits agree on how many they
  are, by exchange alone, within a bounded number of rounds).
- Every op of every round is in the ledger with cause `round:<n>` and
  actor `program:<cid>`; a policy on one bit that forbids programs
  leaves that bit still and the rest running; the round's audit lists it.
- A conductor stops the swarm: with no next round requested, nothing
  runs; the ledger shows the last round's number.

**Design.** In plain words: a swarm is not a mind above the bits; it is
the bits reading each other one face at a time, in step. Everyone
reads, everyone answers, everyone applies, then the conductor says
"again". Order never matters, so the outcome is the same everywhere and
can be checked. A bit that says no to programs simply does not move,
and its neighbors hear its silence.

**Tech:** `SwarmRunner` over any `ActorPool`: `round(n)` = snapshot the
scene's records and each slot's neighbor `data`, `runAll` the `program`
job with `{ round: n }` and the snapshot as input, collect the ops,
apply them in id order through the sink (id order so the ledger is
stable; the outputs do not depend on it), record a `round` summary on
the container's own ledger (a container-level annotation, or the
manifest, a Decision). The durable pool makes a round a workflow, so a
killed worker's round completes exactly once (Phase 15's guarantee,
reused). Growth, a program proposing `add` of an empty neighbor cell, is
a stretch behind its own policy word `grow`.

**Work.**
1. `SwarmRunner`, the snapshot, the synchronous apply; "wave".
2. "gradient" and "count"; the shuffled-order and three-host oracles.
3. The durable round; the conductor over MCP (`run_round`,
   `get_round`); fixtures; journal.

**Exit review.** `/teachback` on why synchronous update makes the
outcome order-independent, and what breaks if a host applies early.

**Risk.** A swarm is a loop; the conductor is the only thing that
prevents it from being an unbounded one. Rounds are requested, never
self-perpetuating; that is a rule, and a test.

---

## Phase 32: The core as the reference

**Today.** TypeScript is the reference; the module, after Phase 29, is a
portable twin of it; the executor and the swarm, after 30 and 31, run in
the hosts.

**Oracle.**
- `openScene`, the demos, the MCP server, and the durable worker run on
  the module through the existing `Container` and `BitHandle`
  contracts; the whole existing unit and e2e suites pass unchanged.
- The WebGPU LED-frame audit compares against the module's frame.
- A pack that carries its module and its programs opens in a reader with
  the model code removed from its bundle; the seal verifies; the reader
  asks before running any program; with consent, one round runs offline
  and its digest equals the published one.
- An ADR records which implementation is the reference from this day;
  `RUNNING.md` says a second implementation may be a host of the module
  or an independent port.

**Design.** In plain words: demote today's program to a shell around the
box, so the box is the definition of the cube. Keep the old code as a
second opinion the kit can still run.

**Tech:** `FlatGridCore` implements `Container` by delegating to
`src/core.ts`; `Grid` and the TypeScript `FlatGrid` stay as the kit's
independent implementations; `scripts/reader-scene.ts --carry-core
--carry-programs`; `src/pack.ts` gains optional `core` and `programs`
entries verification ignores and the reader honors.

**Work.**
1. `FlatGridCore` and the suites green on it.
2. The reader and pack carrying the core and programs; the GPU audit.
3. The ADR, the docs, the program journal.

**Exit review.** `phase-examiner` on the closing oracle: a stranger with
a pack, the module, wasmtime, and consent reproduces a round's digest.

**Risk.** Switching the reference is a one-way door for trust; the two
independent ports the kit keeps running turn a module bug into a
three-way disagreement instead of a silent one.

---

## Sequence and days

| Day | Phase | Deliverable | Oracle |
|-----|-------|-------------|--------|
| 1 | 27 | crate, slots, container, events, replay | slot tables equal `slots.json` |
| 2 | 27 | canonical JSON, digests, seal, lint | tiers 1 and 2 green natively |
| 3 | 28 | self-tests, dirty tracking | render flags equal per fixture |
| 4 | 28 | render list, scene digest, new cameras | tier 3 green natively |
| 5 | 29 | WIT, wasm build, Node host | three tiers in Node |
| 6 | 29 | browser and Python hosts, CI job | Python reports tier 3 passed |
| 7 | 29 | size, speed, release tree, journal | two machines, one module digest |
| 8 | 30 | executor, ABI, limits, blink, echo | four records, hash named |
| 9 | 30 | passport key, policy words, re-execution audit | non-deterministic program fails |
| 10 | 30 | browser and durable hosts, fixtures, SPEC, ADR | same output in three hosts |
| 11 | 31 | SwarmRunner, synchronous apply, wave | front moves one bit per round |
| 12 | 31 | gradient, count, shuffled-order oracle | same digest after 20 rounds, three hosts |
| 13 | 31 | durable round, conductor over MCP, journal | a killed worker's round completes once |
| 14 | 32 | `FlatGridCore`, suites green on it | existing suites unchanged |
| 15 | 32 | pack and reader carry core and programs | reader with no model code runs a round with consent |
| 16 | 32 | ADR, docs, program journal | a stranger reproduces the digest |

Sixteen working days. PLAN-3's ten took one calendar day; PLAN-4's
nineteen took one. This program has no lead time that is not code: the
toolchain is in.

---

## Ticket seeds

Created only when a phase is started, so their oracles reflect what the
previous phase measured. 27.1 and 27.2 exist already as #128 and #129.

| # | Phase | Title |
|---|-------|-------|
| 27.1 | 27 | The core crate: slots, container, events, replay, against the fixtures |
| 27.2 | 27 | Canonical JSON, digests, seal, Ed25519, the determinism lint |
| 28.1 | 28 | The render self-tests and dirty tracking in the core |
| 28.2 | 28 | Render list, scene digest, new camera fixtures |
| 29.1 | 29 | WIT interface, wasm build, the Node host |
| 29.2 | 29 | Browser and Python hosts; the CI `core` job |
| 29.3 | 29 | Size and speed; the release manifest's `core` tree |
| 30.1 | 30 | The `program` workload: fetch by CID, sandbox, limits, blink and echo |
| 30.2 | 30 | Carried programs in the passport; policy words; re-execution audit |
| 30.3 | 30 | Programs in the browser and durable hosts; kit fixtures; SPEC §9.10; ADR 0019 |
| 31.1 | 31 | `SwarmRunner`: snapshot, round, synchronous apply; wave |
| 31.2 | 31 | Gradient and count; shuffled-order and three-host oracles |
| 31.3 | 31 | Durable rounds; the conductor over MCP; journal |
| 32.1 | 32 | `FlatGridCore` behind the container contract |
| 32.2 | 32 | Packs and the reader carry the core and programs; the GPU audit |
| 32.3 | 32 | The reference decision: ADR, RUNNING.md, program journal |

---

## Decisions that are Oscar's

Each in plain words, then the tech line.

- **Kickoff.** Oscar approves the start of the development cycle after
  this plan's final check; no Phase 27 ticket is cut before that.
- **Install the toolchain on this machine.** Decided and done on
  2026-09-06. *Tech: rustup with both wasm targets, wasmtime-py,
  wasm-tools, cargo-component; CI installs its own in the `core` job.*
- **Which libraries the core may depend on.** `serde_json`, `sha2`,
  `ed25519-dalek`, `base64`, all open source from projects with many
  maintainers; the smoke build proved the first three compile to the
  wasm target [V]. *Tech: `Cargo.lock` pinned and its hashes in the
  release manifest.*
- **The size budget.** Proposed 400 KB for the optimized module.
- **Programs default off.** The plan says a bit runs carried code only
  under a policy that names `program` or a CID. Turning that default
  around is possible and is not recommended.
- **Growth.** Whether a swarm program may propose adding a bit to an
  empty neighbor cell (the stretch in Phase 31), behind its own policy
  word. This is where "assembler" would begin to mean what it says.
- **Who conducts.** Whether rounds may be requested only by a person or
  an agent over MCP, or also by a schedule the container carries. The
  plan proposes people and agents only, so no swarm runs unattended.
- **Where a round is recorded.** On the container's own ledger, in the
  manifest, or on each bit only.
- **Whether the module becomes the reference** (Phase 32's ADR), and
  whether published packs carry the core and their programs.
- **Whether Phase 32 runs in this program**, or the program stops after
  31 with the module as a portable twin and TypeScript still the
  reference.

---

## Sources consulted

PUNCHLIST-2.md items 6, 11, and 12; SPEC.md §3.2 and §9.5 for
`Emission.data` as what a node says to the network; ADR 0001 for the
ownership model the sandbox mirrors; `src/vpb.ts`, `src/flat-grid.ts`,
`src/render-list.ts`, `src/verify.ts`, `src/actor.ts` for the arithmetic
the self-tests use, the record key order, and the actor contract;
`conformance/` and `kit/python/`; the probe and installs on this machine
on 2026-09-06. Web reads the same day: the Bytecode Alliance's Component
Model documentation, wasmtime-py's repository, WASI.dev on WASI 0.3, and
the 2026 state-of-WebAssembly surveys listed in the Punchlist 2
discussion.
