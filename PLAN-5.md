# VoxelPixelThingie, Program 5: One core, every host

Plan v1, draft, 2026-09-06. Follows PLAN-4.md (Phases 17 to 25). Drawn
from PUNCHLIST-2.md item 6. Companion to SPEC.md v0.9, ADRs 0001 to 0018,
and the conformance kit in `conformance/`. The other nine items of
PUNCHLIST-2.md stay unscheduled; this program is one item, because it
changes where the rules live.

Labels: **[V]** verified by a source read or a probe on this machine on
the date named. **[T]** trusted from prior knowledge. Everything here is a
proposal; nothing in it has been executed.

Every decision is written twice: in plain words first, then a **Tech**
line for whoever builds it.

---

## Objective, non-goals, assumptions, validation

**Objective.** Move the rules of the bit out of a language and into an
artifact: one WebAssembly module, written in Rust, holding the slot
tables, the container, event stamping and replay, the canonical state
and its digests, the seal, and the four render self-tests. The same
bytes run in the browser, in Node, and from Python, and pass all three
conformance tiers in all three, so tier 3 stops being TypeScript's alone
and the reference implementation becomes a thing with a hash.

**Non-goals.** No change to what a bit is or to any format. No stores,
witnesses, DID resolution, MCP, or renderers inside the module; those
touch the world and stay in the hosts. No WebGPU in the module. No new
event types. No vendor: the toolchain is the Rust project's and the
Bytecode Alliance's, both open source with more than one maintainer
[T]. No account to test anything.

**Assumptions.**
- One engineer plus the review agents, the CONTRIBUTING.md ritual,
  tickets with oracles before branches.
- The conformance kit is the contract. The module is built against
  `conformance/` from the first commit and replaces nothing until every
  case passes.
- The model's TypeScript is about 2,400 lines across nine files [V:
  `wc -l` 2026-09-06], and the render self-tests use only addition,
  multiplication, division, square root, and one comparison against
  `FACING_EPSILON = 1e-4` [V: `src/vpb.ts`, `src/flat-grid.ts`], which
  WebAssembly evaluates identically on every host [T: the core
  specification's IEEE 754 semantics; no transcendental instructions].
- The toolchain is installed and proven on this machine, with Oscar's
  go-ahead on 2026-09-06 [V]: rustup 1.29.1, cargo 1.98.1 on the MSVC
  host (Visual Studio 2022 Community's C++ tools were already present),
  targets `wasm32-unknown-unknown` and `wasm32-wasip2`, wasmtime-py
  48.0.0; `wasm-tools` and `cargo-component` were being built from
  source at the time of writing. A smoke crate at `core/` with `sha2`
  and `ed25519-dalek` compiles natively (tests pass) and to a 36.8 KB
  module that Node 22 and Python both load and call with the same
  result [V].
- Hosts exist in the field: browsers run core modules and jco transpiles
  components for them [V: Bytecode Alliance docs, read 2026-09-06];
  wasmtime-py supports components [V: same day]; WASI 0.3 shipped in
  2026 with 1.0 expected around the turn of the year [V], and the core
  needs none of it, only arithmetic and memory.

**Validation.** Each phase names an oracle that can fail, run in CI
where CI can reach it. The program's closing oracle: the Python kit
runner reports tier 3 as passed, through the module, on the same
fixtures TypeScript passes; the module's digest is in the release
manifest and is equal when built on two machines; a pack that carries
its module opens in a reader that contains no model code.

---

## Standards carried forward

PLAN-4.md's three stand (a reader in the box; accessibility is an
oracle; no account to test). Two more:

- **The fixtures are the contract, neither codebase is.** A behavior
  change lands as a fixture first, then in the module, then in any host.
- **Determinism is enforced, not assumed.** The crate refuses at build
  time any floating-point operation the WebAssembly core cannot compute
  bit-identically. A lint that could fail is part of the oracle.

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

**Tech:** a Rust crate at `core/` with modules `slots` (the sign
convention and partner tables, checked against `conformance/slots.json`),
`grid` (the typed-array container's semantics: cells by position, ids,
derived links, presence, move), `events` (stamping, the wrangler
context, report-then-apply), `replay`, `canon` (canonical JSON with
JavaScript's number formatting: whole-number floats as integers,
shortest round-trip otherwise, exponent thresholds matched), `digest`
(SHA-256 via the `sha2` crate), `seal` (seal text, per-file hashes,
Ed25519 verification via `ed25519-dalek`). Dependencies are libraries
from the RustCrypto and dalek projects, not services; the list is a
Decision. Tests read the fixtures directly, the way `run_kit.py` does.

**Work.**
1. The crate, the slot tables, the container, events, replay.
2. Canonical JSON and the state digest; the tier 2 fixtures green.
3. Seal hashes and Ed25519; the tier 1 fixtures green; the lint.

**Exit review.** `falsifier` on "the canonical JSON is byte-equal to
JavaScript's": the reproduction is a fixture of hostile numbers (1e21,
1e-7, 0.1 + 0.2, negative zero) added to tier 2.

**Risk.** Number formatting is where two languages disagree first; the
hostile-number fixture exists before the formatter is declared done.

---

## Phase 28: Tier 3 in the core

**Today.** The render self-tests (§8) and the render list are TypeScript
only; Python skips tier 3 by design.

**Oracle.**
- `cargo test` passes every tier 3 fixture: `renderCycle` and
  `renderEnabled` per bit for each camera, and the scene digest.
- The determinism lint still passes with the self-tests in the crate:
  square root is the only non-arithmetic float operation.
- `cameraMoved` (incremental) agrees with a full `evaluate` before and
  after a removal, as the TypeScript conformance suite already demands.

**Design.** In plain words: move the cube's "should I draw myself"
decisions into the box. They are the first act of agency in the thing,
so they must be bit-identical everywhere, and they can be, because they
need no fancy arithmetic.

**Tech:** `render` module: presence, enclosure, coverage, facing (the
inclusive and exclusive rules at the plane, epsilon 1e-4), the awake set,
static-dirty and camera-dirty reruns, `renderList`. `sceneCanonical`
adds `links`, `renderCycle`, and `renderEnabled` in the record key
order the kit publishes.

**Work.**
1. The self-tests and the dirty tracking.
2. The render list and the scene digest; tier 3 green natively.
3. Three more cameras added to the fixtures, including one edge-on.

**Exit review.** `/roast` on the facing test's edge cases: a node exactly
on the plane, an orthographic camera from below.

**Risk.** Order of evaluation. The TypeScript visits awake bits in a
particular order; the flags must not depend on it, and a shuffled-order
test proves they do not.

---

## Phase 29: The module and its three hosts

**Today.** The crate runs natively. Nothing runs it in a browser, in
Node, or from Python.

**Oracle.**
- The same `core.wasm` passes all three tiers in Node, in Chromium
  (Playwright), and from Python (`run_kit.py --core core.wasm`), and the
  Python runner reports tier 3 as passed, not skipped.
- Two builds of the same commit, on this machine and on CI's Linux
  runner, give byte-identical `core.wasm`; its SHA-256 is in the release
  manifest under a `core` tree.
- Size: the optimized module is under the budget set in Decisions
  (proposed 400 KB). Speed: replaying the 8³ reference scene through the
  module is no slower than the TypeScript, measured and written down.

**Design.** In plain words: seal the rules into the box and prove the
box gives the same answers on all three kinds of computer. Talk to the
box in whole jobs, never in a chatter of small calls.

**Tech:** target `wasm32-unknown-unknown` for the browser and Node core
module, and a component via `cargo-component` with a WIT interface
(`core/wit/vpb.wit`) for hosts that speak the Component Model; jco
transpiles the component for the browser [V], wasmtime-py loads it for
Python [V]. The interface is batch-shaped and text-based: `open(pack)`,
`replay(events)`, `apply(ops)`, `state()`, `state_digest()`,
`evaluate(camera)`, `scene_digest(camera)`, `render_list()`,
`verify(pack, did_document)`; JSON in, JSON out, so every host's binding
is the same and the canonical text never crosses a language boundary
un-serialized. Hosts: `src/core.ts` (loads the module in Node and the
browser), `kit/python/run_kit.py --core` (wasmtime-py). CI gains a
`core` job: rustup, cargo test, the wasm build, the size gate, the
digest printed and uploaded; `release:build` gains the `core` tree.

**Work.**
1. The WIT interface and the wasm build; the Node host; tiers 1 to 3 in
   Node.
2. The browser host under Playwright; the Python host; the CI job.
3. Size and speed measured; the release manifest's `core` tree; the
   journal.

**Exit review.** `big-bruiser` on the interface: no host can reach model
state except through the named calls; no call takes or returns anything
but text and numbers.

**Risk.** Host-to-module crossings cost per call; the batch interface is
the design answer, and the speed oracle is what proves it worked.

---

## Phase 30: The core as the reference

**Today.** TypeScript is the reference; the module, after Phase 29, is a
portable twin of it.

**Oracle.**
- `openScene`, the demos, the MCP server, and the durable worker run on
  the module through the existing `Container` and `BitHandle` contracts;
  the whole existing unit and e2e suites pass unchanged.
- The WebGPU LED-frame audit compares against the module's frame.
- A pack that carries its module (`vpb-core` block in the reader, and a
  `core` entry in the scene pack) opens in a reader with the model code
  removed from its bundle; the seal verifies; the digest is the
  published one.
- ADR 0019 (or the next free number) records which implementation is
  the reference from this day, and `RUNNING.md` says a second
  implementation may be a host of the module or an independent port.

**Design.** In plain words: demote today's program to a shell around the
box, so the box is the definition of the cube. Keep the old code in the
repository as a second opinion the kit can still run.

**Tech:** `FlatGridCore` implements `Container` by delegating to
`src/core.ts`; `Grid` and the TypeScript `FlatGrid` stay as the kit's
independent implementations. `scripts/reader-scene.ts` gains
`--carry-core`; `src/pack.ts` gains an optional `core` field (format,
sha256, base64) that verification ignores and the reader honors. The
Python `vpb.py` stays as the independent port of tiers 1 and 2.

**Work.**
1. `FlatGridCore` and the suites green on it.
2. The reader and pack carrying the core; the GPU audit rewired.
3. The ADR, the docs, the program journal.

**Exit review.** `phase-examiner` on the closing oracle: a stranger with
a pack, the module, and wasmtime alone reproduces the published digest.

**Risk.** Switching the reference is a one-way door for trust: after it,
a bug in the module is the truth until fixed. The mitigation is the two
independent ports the kit keeps running, TypeScript and Python, which
turn a module bug into a three-way disagreement instead of a silent
one.

---

## Sequence and days

| Day | Phase | Deliverable | Oracle |
|-----|-------|-------------|--------|
| 1 | 27 | crate, slots, container, events, replay | slot tables equal `slots.json` |
| 2 | 27 | canonical JSON, state digest, seal, lint | tiers 1 and 2 green natively |
| 3 | 28 | self-tests, dirty tracking | render flags equal per fixture |
| 4 | 28 | render list, scene digest, new cameras | tier 3 green natively |
| 5 | 29 | WIT, wasm build, Node host | three tiers in Node |
| 6 | 29 | browser and Python hosts, CI job | Python reports tier 3 passed |
| 7 | 29 | size, speed, release tree, journal | two machines, one module digest |
| 8 | 30 | `FlatGridCore`, suites green on it | existing suites unchanged |
| 9 | 30 | pack and reader carry the core, GPU audit | reader with no model code opens the pack |
| 10 | 30 | ADR, docs, program journal | a stranger reproduces the digest |

Ten working days, the same shape as PLAN-3.md, which took one calendar
day in practice. This program has one lead time that is not code: the
toolchain install, which is a Decision.

---

## Ticket seeds

Created only when a phase is started, so their oracles reflect what the
previous phase measured.

| # | Phase | Title |
|---|-------|-------|
| 27.1 | 27 | The core crate: slots, container, events, replay, against the fixtures |
| 27.2 | 27 | Canonical JSON, digests, seal, Ed25519, the determinism lint |
| 28.1 | 28 | The render self-tests and dirty tracking in the core |
| 28.2 | 28 | Render list, scene digest, new camera fixtures |
| 29.1 | 29 | WIT interface, wasm build, the Node host |
| 29.2 | 29 | Browser and Python hosts; the CI `core` job |
| 29.3 | 29 | Size and speed; the release manifest's `core` tree |
| 30.1 | 30 | `FlatGridCore` behind the container contract |
| 30.2 | 30 | Packs and the reader carry the core; the GPU audit against it |
| 30.3 | 30 | The reference decision: ADR, RUNNING.md, program journal |

---

## Decisions that are Oscar's

Each in plain words, then the tech line.

- **Install the toolchain on this machine.** Decided and done on
  2026-09-06: rustup with both wasm targets, wasmtime-py, and the
  component tools. *Tech: `rustup` with `wasm32-unknown-unknown` and
  `wasm32-wasip2`, `cargo-component`, `wasm-tools`, `pip install
  wasmtime`.* CI installs its own in the `core` job.
- **Kickoff.** Oscar approves the start of the development cycle after
  this plan's final check; no Phase 27 ticket is cut before that.
- **Which libraries the core may depend on.** The plan proposes
  `serde_json`, `sha2`, `ed25519-dalek`, and `base64`, all open source
  from projects with many maintainers; the alternative is to write
  SHA-256 and Ed25519 by hand as the Python kit did, at the cost of a
  week and more surface to audit. The smoke build proved the first three
  compile to the wasm target [V]. *Tech: a `Cargo.lock` pinned and its
  hashes in the release manifest either way.*
- **The size budget.** Proposed 400 KB for the optimized module, the
  number that decides whether a pack can carry its core without doubling
  the reference scene's reader.
- **Whether the module becomes the reference** (Phase 30's ADR), and
  whether published packs carry it.
- **Whether Phase 30 runs at all in this program**, or stops after 29
  with the module as a portable twin and TypeScript still the reference.

---

## Sources consulted

PUNCHLIST-2.md item 6; `src/vpb.ts`, `src/flat-grid.ts`,
`src/render-list.ts`, `src/verify.ts` for the arithmetic the self-tests
use and the record key order; `conformance/` and `kit/python/` for the
fixtures and the second implementation; the probe of this machine's
toolchain on 2026-09-06. Web reads the same day: the Bytecode Alliance's
Component Model documentation (language support, jco, running
components), wasmtime-py's repository, WASI.dev on WASI 0.3, and the
2026 state-of-WebAssembly surveys listed in the Punchlist 2 discussion.
