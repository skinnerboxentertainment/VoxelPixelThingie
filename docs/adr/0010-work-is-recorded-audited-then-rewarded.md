# ADR 0010: Work is recorded, audited, then rewarded, in that order

Date: 2026-09-06. Status: accepted.

## Context

PLAN-3.md Phase 12 asks that a bit be a unit compute can attach to. The
field survey (docs/research/compute-attachment.md) and the Radoff
livestream library both land on the same shape for that: work is
requested, a result is produced, an audit checks it, and only then is a
reward given. The bit already has an append-only ledger with actor and
cause; what it lacked was a vocabulary for work and a place for results
too big for a passport.

Two ways were open: new event types, which changes SPEC.md §9.2 and every
container, sink, and exporter that switches on the type; or a convention
inside the existing `annotated` event, which changes nothing a container
does and everything a reader can find.

## Decision

- **Job records are `annotated` events under reserved keys**:
  `job:request`, `job:result`, `job:audit`, and optionally `job:reward`,
  sharing an `id`. The reference sink validates their shape and refuses a
  malformed one; other annotation keys are untouched. A container that has
  never heard of jobs stores them; a reader that has finds them with
  `jobsOf`.
- **The order is fixed and the audit is the point.** The result is
  recorded whether or not its check passed; the audit names the check in
  words a stranger can repeat and says whether it passed; a reward is
  written only after an audit that passed. A workload that throws is a
  failed audit, not a lost job.
- **Results by content id.** Anything over 4 KiB goes to a `Storage`
  behind `put(bytes) → cid` and `get(cid)`, and the result record carries
  the id. The id is a CIDv1 with the raw codec and a SHA-256 multihash,
  which is what IPFS gives a small raw-leaf file, so one id names the
  bytes wherever they sit. Memory and folder backends ship; any
  S3-compatible store or pinning service is one more backend.
- **One actor per bit, behind a contract.** `Actor.run(job)` writes the
  records; an `ActorPool` hands out actors and bounds concurrency across
  bits while keeping one job at a time per bit. The reference pool runs in
  process over `FlatGrid`. Durable backends arrive in Phase 15 behind the
  same contract, and the first workloads are the project's own: the LED
  frame, the EPCIS document, the link check, each with a check that can
  fail.
- **EPCIS sees work as observations.** A job record exports as an
  ObjectEvent OBSERVE whose business step is the record's step
  (`job-request`, `job-result`, `job-audit`, `job-reward`) with a
  `vpb:job` sensor report carrying the record.

## Consequences

- No model change, no container change, no new event type. The
  conformance suite gains nothing; the sink gains a validator.
- Key-prefixed annotations are a convention, and a wrangler can write
  nonsense under other keys as before. The validator at the sink and
  `jobsOf`'s tolerance for malformed records are what keep the convention
  honest.
- The links check is the first audit that can fail for a real reason: a
  neighbor that does not link back. The LED-frame and EPCIS checks are
  invariants of their own output, not second implementations, and say so.
