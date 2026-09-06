# ADR 0018: The conformance kit is fixtures, not a language

Date: 2026-09-06. Status: accepted.

## Context

The conformance suite was TypeScript (`tests/conformance/container-suite.ts`)
with the reference numbers in code. A second implementation would have
had to read our tests to know what to match, and could only be checked by
porting them. PUNCHLIST.md item 9 asked for the rules as fixtures any
language can read, proven by a second implementation that passes them.

## Decision

- **Fixtures are inputs and expected answers in JSON.** `conformance/`
  holds a manifest, the slot tables as data, packed scenes with expected
  state and verdicts (tier 1), operation scripts with expected events and
  state (tier 2), and cameras with expected render flags (tier 3).
  RUNNING.md says what an implementation must do in words.
- **The state digest is the kit's digest.** The scene digest (§10.9)
  covers render flags after a camera pass, which ties it to the self-test
  logic of §8. Tiers 1 and 2 use a state digest instead: ids, positions,
  presence, colors, passports, emissions, and the links derived from
  geometry, canonical JSON, SHA-256. The scene digest stays the spime
  test and is tier 3.
- **The TypeScript implementation runs from the fixtures too.** The kit
  runner replaces nothing; the container suite stays. But every fixture
  passing under TypeScript is what proves the fixtures complete, and the
  exporter that writes them is the same code the runner checks.
- **Python is the second implementation.** Standard library only, tiers
  1 and 2, with Ed25519 verification after RFC 8032's reference code so
  the signed case needs no package. Python was chosen as the widest-reach
  language with no toolchain friction; any other would do.
- **CI runs both.** The kit test in the Node job, the Python runner in
  its own job. Two implementations drifting shows up as one of them
  failing the same fixtures.

## Consequences

- `stateCanonical` and `stateDigest` join `src/verify.ts`. The slot
  tables are exported as data, so an implementation does not re-derive
  the sign convention from prose.
- Canonical JSON has rules a second language must follow: no spaces,
  insertion-order keys, whole-number floats printed as integers,
  non-ASCII unescaped. RUNNING.md lists them; the Python `Canon` class
  is the worked example.
- The render self-tests remain TypeScript-only. A Python tier 3 is the
  stretch this phase did not take.
- The signed fixture is re-minted on each export with a fresh key; the
  fixtures are self-contained but the signed case's bytes change per
  export, which the journal notes.
