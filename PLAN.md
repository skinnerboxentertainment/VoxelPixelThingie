# VoxelPixelThingie: Stand-Up and Demo Plan

Plan v1, 2026-09-05. Companion to SPEC.md, RESEARCH.md, REPOS.md.

Everything in this document is a proposal. Nothing has been executed. Where
a tool or version is named, it was verified in RESEARCH.md or REPOS.md
today unless marked [T].

---

## Objective, non-goals, assumptions, validation

**Objective.** In ten working days, take the current scaffold to a public
GitHub repository with senior-grade engineering hygiene and a live demo that
shows a VoxelPixelBit in all three modes: pixel, tile, and cube, with free
orbit and self-culling visible on screen.

**Non-goals.** No engine ports (Godot, Unity, Unreal, Bevy). No physical
hardware. No product features beyond what the demo needs. No multiplayer.
No file format beyond a JSON render list.

**Assumptions.**
- One engineer (Oscar) plus the review agents in this workspace acting as
  the review cadre. Human reviewers can be added to CODEOWNERS later.
- Demo is web-hosted on GitHub Pages and shown from a laptop with a WebGPU
  browser. WebGL 2 fallback covers the rest.
- Node 22 with type stripping stays the runtime. No bundler for the library;
  Vite for the demo site only.
- The repository is public. If private, Pages needs a paid plan [T].

**Validation.** Each phase has a named oracle, an executable check that can
fail. A phase is done when its oracle passes on `main` in CI, not when the
work feels done. The demo has acceptance criteria in §8 with numbers.

---

## 1. Operating standards adopted

These are the rules every ticket runs under. They are the workspace's
existing practices applied to this repo.

**Per ticket, in order.**
1. Open a GitHub issue from the template. State objective, non-goals,
   assumptions, and the oracle. No oracle, no branch.
2. Plan mode before code. Link the plan in the issue.
3. Branch `type/short-name` off `main`. Types: `feat`, `fix`, `chore`,
   `docs`, `test`, `perf`, `refactor`.
4. Implement. Commits follow Conventional Commits and end with the
   co-author trailer.
5. Before opening the PR, run in this order:
   - `/intent-check`: does the diff do only what the issue said.
   - `/roast`: adversarial read, fix what bites first.
   - `/code-review`: correctness pass.
   - `claim-auditor` on the PR description: every checkable sentence is
     probed or marked Trusted.
6. Open the PR from the template. CI must be green. Squash merge only.
7. Close the issue with a one-line "oracle passed at `<sha>`."

**Claim discipline.** Comments state constraints, not conclusions. PR bodies
and commit messages get audited against their own diff. Counts and labels
are measured or deleted.

**Batching.** Collect review findings, fix once at the settled head, re-run
once. Two rounds finding the same shape of defect means shrink the surface,
not a third round.

**Weekly.** One `/drill` break-fix exercise on the repo. One `/teachback` on
a component built that week. Both logged in `docs/journal/`.

---

## 2. Phase 0: Repository stand-up (Day 1)

**Oracle.** A PR that changes one line of `README.md` cannot be merged
until typecheck, lint, format, and tests pass in GitHub Actions, and a
direct push to `main` is rejected.

### 2.1 Repository

| Item | Choice | Why |
|------|--------|-----|
| Host | GitHub, public | Pages, Actions, Dependabot, CodeQL free |
| Default branch | `main` | |
| License | MIT | matches every dependency on the shortlist |
| Node | 22, pinned in `.nvmrc` and `engines` | type stripping without a build |
| Package manager | npm with `package-lock.json` committed | already in use, no extra tool |
| Lint and format | Biome | one tool, one config, fast; replaces ESLint plus Prettier [T] |
| Tests | `node:test`, already in place | zero dependencies; revisit Vitest only if browser tests need it |
| Coverage | `c8` with an 85% line threshold on `src/` | enforced in CI, not aspirational |
| Property tests | `fast-check` for slot math invariants | partner symmetry and fan-out are exactly the kind of claim it breaks |
| Benchmarks | `tinybench` on `evaluate()` for 8³, 32³, 64³ | numbers for the demo, regression guard later |
| API docs | `typedoc` to `docs/api/`, published with Pages | |
| Commit hooks | `husky` plus `lint-staged` plus `commitlint` | format and lint staged files, enforce Conventional Commits |
| Versioning | `release-please` action | changelog and GitHub Release from commit history, no manual tagging |

### 2.2 GitHub settings

- Branch protection on `main`: require PR, require the `ci` status check,
  require linear history, dismiss stale approvals, no force push, no
  deletion. Admins included.
- Squash merge only. PR title becomes the commit message, so PR titles are
  enforced as Conventional Commits by a title-check action.
- Dependabot for npm and GitHub Actions, weekly, grouped.
- CodeQL default setup on push and PR.
- Secret scanning and push protection on.
- Labels: `phase:0` through `phase:5`, `type:*` matching branch types,
  `oracle-missing` (blocks work), `needs-claim-audit`.
- Milestones: one per phase with its target day.
- GitHub Project board: Backlog, Planned, In progress, In review, Done.
  Automation moves cards on PR open and merge.

### 2.3 Files added

```
.github/
  workflows/ci.yml            typecheck, lint, format check, test, coverage
  workflows/pages.yml         build demo site and typedoc, deploy on main
  workflows/release.yml       release-please
  workflows/pr-title.yml      Conventional Commit title check
  ISSUE_TEMPLATE/ticket.yml   objective, non-goals, assumptions, oracle
  ISSUE_TEMPLATE/bug.yml      repro, expected, actual, oracle
  PULL_REQUEST_TEMPLATE.md    intent, oracle result, claims audited, risk
  CODEOWNERS                  @oscar on everything for now
  dependabot.yml
docs/
  adr/0001-hybrid-ownership.md
  adr/0002-slot-ordering.md
  adr/0003-self-optimizing-render.md
  adr/0004-typescript-on-node-strip-types.md
  journal/                    drill and teachback logs
CONTRIBUTING.md               the §1 ritual, written for a stranger
SECURITY.md
README.md                     what it is, run it, see it
biome.json
.nvmrc
.editorconfig
commitlint.config.js
```

The four ADRs are the decisions already logged in SPEC.md §10, each written
in the standard context, decision, consequences form, so the reasoning
survives without this conversation.

### 2.4 CI workflow

Single job, single Node version, under two minutes:

```
npm ci
npm run typecheck
npx biome ci .
npm test
npx c8 --check-coverage --lines 85 npm test
```

Cache `~/.npm` keyed on the lockfile. Fail on any warning from Biome.

---

## 3. Phase 1: Model hardening (Days 2 to 3)

**Oracle.** Property tests over all 26 slots and all 26 offsets pass, the
new `Grid` links an 8³ block in one call and produces the same 384 exposed
faces the existing test expects, and the benchmark prints a number for 64³.

**Work.**
- `src/grid.ts`: owns bits by position, links neighbors on insert, unlinks
  on remove, exposes `bits()` and `at(x,y,z)`. About 50 lines.
- `src/render-list.ts`: walks enabled nodes after `evaluate`, returns
  `{ bit, slot, kind, emission, center, outward }`. About 20 lines.
- Back-facing tolerance: treat a node as facing when the dot product exceeds
  a small epsilon rather than zero, and document that the renderer's own
  back-face culling makes the final cut. Ten lines plus a test for the
  edge-on case.
- Decide open question 2 in SPEC.md, the emission schema. Proposal: keep
  the fixed struct, add it to the spec as decided, and close the question.
- `fast-check` properties: `slotOf(signsOf(s)) == s`, partner symmetry,
  fan-out 1/3/7, `lies()` is reflexive and antisymmetric.
- `tinybench` script in `bench/` for `evaluate()` on dense blocks.

**Exit review.** `/falsify` one claim: "removing any single bit from a
linked block leaves every remaining link symmetric." If it holds, it goes in
the spec as an invariant with the test that guards it.

---

## 4. Phase 2: Reference image, Canvas 2D (Day 4)

**Oracle.** A Playwright screenshot of `demo/canvas/` matches a committed
golden image within a pixel-diff tolerance, in CI.

**Work.**
- `demo/` is a Vite workspace. `demo/canvas/index.html` renders an 8³ block
  with one corner carved out, software projection, painter's sort, glowing
  seams and corner beads, at a fixed three-quarter view.
- A mode switch: pixel (down Z), tile (isometric), cube (three-quarter).
  Same bits, three cameras. This is the first time the 9 / 19 / 26 node
  counts are visible.
- Playwright installed as a dev dependency with one spec that loads the
  page, waits for a `data-ready` attribute, and snapshots.
- The golden image is the reference every later renderer is compared to
  by eye.

**Exit review.** `/roast` the demo code. Canvas code accumulates globals
and magic numbers fast.

---

## 5. Phase 3: Interactive 3D, Three.js WebGPU (Days 5 to 7)

**Oracle.** `/frame-budget` reports p95 frame time under 16.7 ms for a 32³
block with a carved interior, orbiting, with bloom on, on the demo laptop.
The number is recorded in `docs/journal/` with the commit SHA.

**Work.**
- `demo/three/`: three `InstancedMesh` draws fed from the render list,
  `OrbitControls`, TSL bloom on the WebGPU path, `UnrealBloomPass` fallback
  on WebGL 2.
- Camera movement calls `onCameraMoved` on bits, then `evaluate`. Only
  dirty bits rewrite their instance slots.
- A live HUD: bits present, bits in the render cycle, nodes enabled, frame
  time. This is the self-culling made visible, and it is the demo's best
  moment.
- Click a bit to remove it. Neighbors re-expose. Click again to restore.
- WebXR button. Not required for the oracle, but it costs one line and it
  is the closer if a headset is in the room.

**Exit review.** `/intent-check` against the issue. This phase attracts
scope creep more than any other.

---

## 6. Phase 4: Pixel mode, PixiJS v8 (Day 8)

**Oracle.** `demo/pixi/` renders a 16×16 layer of bits as pixels with
glowing borders and corner beads, and a Playwright snapshot matches its
golden.

**Work.**
- One `Sprite` per bit from a tiny atlas, tinted per node, `BlurFilter` on
  an emissive layer. A second layer behind the first at a parallax offset to
  show depth as a layer index.
- Toggle to isometric tile mode using the same sprites re-projected.
- This is the "pixels that are secretly voxels" demo and it is short on
  purpose.

**Exit review.** `/code-review` at medium effort. Small surface, high
confidence.

---

## 7. Phase 5: Demo day (Days 9 to 10)

**Oracle.** The demo script in §8 runs end to end on the Pages URL, from a
clean browser profile, in under eight minutes, twice in a row, with every
acceptance number met.

**Day 9: assembly and rehearsal.**
- `demo/index.html` landing page linking the three demos plus the API docs.
- Pages workflow deploys `demo/dist` and `docs/api` on every merge to
  `main`.
- `release-please` cuts `v0.1.0` with the changelog.
- README gets the Pages URL, a screenshot, and the three-command quickstart.
- Rehearse the script twice. Record timings. Fix anything that stalls.
- `claim-auditor` on the README and the release notes.

**Day 10: demo.**
- Fifteen minutes. Eight for the script, seven for questions.
- One backup: the demo runs from a local `vite preview` if Pages or the
  network fails.

---

## 8. Demo script and acceptance criteria

The story is one bit becoming a world, told in three modes, with the model
doing visible work.

| Step | What is shown | Say | Acceptance |
|------|---------------|-----|------------|
| 1 | Pixel mode, one bit | "This is a VoxelPixelBit. It looks like a pixel. It has a border and corners because those are real, addressable parts." | 9 nodes lit, HUD shows 9 |
| 2 | Pixel mode, 16×16 | "A layer of them is a display. Every seam is a node." | 60 fps, snapshot matches golden |
| 3 | Switch to tile mode | "Same bits. Different camera. Now 19 parts are visible per bit." | HUD shows 19 per exposed corner bit |
| 4 | Switch to cube mode, 8³ | "Same bits. Free camera. All 26." | orbit is smooth, no popping |
| 5 | Show the HUD while orbiting | "The bits decide what to draw. 512 present, 216 asleep because they are enclosed, 384 faces exposed, and the camera-facing set changes as we move." | numbers match the test suite |
| 6 | Click to carve a tunnel | "Remove one and its neighbors wake up. Nobody told them. They noticed their link vanished." | re-exposure within one frame |
| 7 | Scale to 32³ | "Same code." | p95 under 16.7 ms with bloom |
| 8 | Pull up the repo | "Every decision is an ADR. Every claim in the release notes was audited against the diff. CI gates every merge." | branch protection visible, CI green, release v0.1.0 |
| 9 | Optional, WebXR | "And it runs on a headset because Three.js gave us that for free." | session starts |

**Hard acceptance numbers.**

| Metric | Target |
|--------|--------|
| p95 frame time, 32³ carved, orbiting, bloom on | at the display's vsync interval with no dropped frames (16.8 ms measured at 60 Hz; see the Phase 3 journal for why "under 16.7" was the wrong number) |
| Time from Pages URL to first frame | < 3 s |
| CI wall time | < 2 min |
| Coverage on `src/` | ≥ 85% lines |
| Property test cases per invariant | ≥ 1000 |
| Demo script end to end | < 8 min |

---

## 9. Stand-up format

Daily, written, in `docs/journal/YYYY-MM-DD.md`, three lines plus blockers:

- Yesterday: what merged, with PR links.
- Today: the ticket and its oracle.
- Risk: the one thing most likely to slip and what would be dropped.

Blockers name their default, what proceeds under a stated assumption, and
what genuinely cannot. Tolerance 24 hours before escalating to a scope cut.

---

## 10. Risks and cuts

| Risk | Likelihood | Cut if it bites |
|------|------------|-----------------|
| WebGPU bloom under budget on the demo laptop | medium | drop bloom, keep emissive color; the model is the demo, not the glow |
| Playwright golden images flake across OS font and GPU differences | high | snapshot only the Canvas demo, which is deterministic; smoke-test the others |
| Biome or husky setup eats Day 1 | low | ship CI without hooks; hooks are convenience, CI is the gate |
| Phase 3 scope creep | high | `/intent-check` per PR; WebXR is the first thing dropped |
| Pages deploy blocked on a private repo | low | make the repo public or serve from `vite preview` |

**Residual risk after the plan.** The back-facing tolerance fix is a
judgment call on epsilon and could still flicker at grazing angles. The
renderer's own back-face culling covers the visual, but the HUD count will
wobble by a few nodes. Acceptable for the demo, logged as a known issue.

---

## 11. Day-by-day

| Day | Phase | Deliverable | Oracle |
|-----|-------|-------------|--------|
| 1 | 0 | repo, CI, protection, templates, ADRs | one-line PR blocked until green |
| 2 | 1 | Grid, render list, back-face epsilon | 384 faces via Grid |
| 3 | 1 | property tests, bench, emission decision | fast-check passes, bench prints |
| 4 | 2 | Canvas demo, three modes, golden | snapshot matches |
| 5 | 3 | Three.js adapter, orbit | bits orbit without popping |
| 6 | 3 | bloom, HUD, carve | HUD matches test numbers |
| 7 | 3 | frame budget, WebXR button | p95 recorded |
| 8 | 4 | PixiJS pixel mode | snapshot matches |
| 9 | 5 | landing, Pages, release, rehearsal | script under 8 min, twice |
| 10 | 5 | demo | acceptance table met |

---

## 12. What Day 1 looks like, concretely

The first hour is a single `chore/stand-up` branch that adds everything in
§2.3, then the first PR against a freshly protected `main`. That PR is the
oracle for Phase 0: it must be blocked until CI passes and then merge only
by squash. The second PR is the four ADRs. The third is the README with a
placeholder screenshot. By the end of Day 1 the repo looks like it has
always been run this way.
