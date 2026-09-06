# ADR 0014: Policy is a passport key the sink enforces

Date: 2026-09-06. Status: accepted.

## Context

Any actor with the model could change any bit. The wrangler context
records who did it, and the SPEC said plainly that this is "a convenience
for honest logs, not a security boundary" (§9.6). With agents attached
over MCP (Phase 14) and actors running work (Phases 12, 15, 16), a bit
needed a way to say no: who may change it, what work it will take, and
whether software may act on it at all. PUNCHLIST.md item 3.

The field's vocabularies for this are ODRL 2.2 (a W3C Community Group
specification, used across data spaces), capability tokens such as UCAN
and ZCAP for delegation between parties, and plain allow-lists. A bit's
passport is small and a bit has one owner; a hundred-byte rulebook it
enforces on itself is the fit, with ODRL as the export for anyone whose
tools speak it and capabilities deferred until there is a second party.

## Decision

- **A reserved passport key, `policy`, with a fixed small vocabulary.**
  `controllers`, `actors.allow`, `actors.deny`, `agents`, `work`,
  `version: 1`. Nothing else. A malformed policy is refused before it
  lands, so a bit never carries a rulebook the sink cannot read.
- **The sink judges; the container stays blind.** `SceneSink.record`
  judges every event against the bit's current policy. The container
  reports an event before it applies it, so a sink that throws leaves the
  in-memory state untouched: the refusal is complete without the
  container knowing policy exists. The sink keeps the policies in step
  at record time, not at drain time, so a policy set earlier in the same
  tick already governs.
- **A refusal is written down.** The sink writes `policy:refused`, actor
  `policy`, at the sequence number the refused event would have taken,
  carrying the refused actor, type, key, and rule. The history shows who
  was turned away, and the sequence stays contiguous. Only the sink may
  write that key.
- **Replay is exempt.** Events stamped `actor: "replay"` are never
  judged, so a policy that tightens after the fact still replays the
  history that made the bit. Link bookkeeping is exempt for the same
  reason: it is the container's, not an actor's.
- **Work is refused as a failed audit.** The in-process pool catches the
  refusal of `job:request` and records `job:audit` with `passed: false`
  and the rule; no result is stored. An actor shut out entirely cannot
  write even the audit, and that error propagates, which is the honest
  outcome.
- **ODRL is the export, not the contract.** `scripts/export-policy.ts`
  renders the enforced form as an ODRL Set one to one. The other
  direction is not offered: the policy the sink enforces is the one the
  passport carries.

## Consequences

- SPEC v0.9 §9.5 reserves the key; §9.8 states the rules. A passport
  without a policy behaves exactly as before, and the whole prior suite
  passes unchanged.
- A container without a scene sink enforces nothing. The passport page,
  the demos before a save, and any in-memory grid are open; the ledger is
  where the door is. A demo that wants the door attaches the sink.
- The durable backend records through the same sink; a refusal there is
  an activity failure and is marked non-retryable, so the workflow fails
  fast instead of retrying a decision the bit has already made.
- The wrangler context remains a convention: an actor may lie about its
  name. Policy binds honest actors and software that goes through the
  door; keys and signatures (Phases 11, 18) are the boundary for
  everything else.
