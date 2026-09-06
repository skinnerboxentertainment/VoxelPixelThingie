# Running the conformance kit

This folder is the rules for "a correct VoxelPixelBit" as inputs and
expected answers, in JSON, for any language. PLAN-4.md Phase 25, ADR 0018.
Nothing here needs the TypeScript in this repository.

## What is here

- `manifest.json`: the format (`vpb-conformance/1`), the tiers, and the
  case names.
- `slots.json`: the 26 node slots (kind and sign per axis) and, for each
  of the 26 neighbor offsets, the partner slot of every slot, or -1. Read
  this instead of re-deriving the sign convention.
- `tier1/<case>/pack.json`: a packed scene (`vpb-scene-pack/1`): a
  manifest and, per bit, its `passport.json` text and `events.jsonl`
  text. `expected.json` beside it: the state digest, the full state, the
  bit counts, the seal verdict (which files differ), and the signature
  verdict. `did.json` when the seal is signed.
- `tier2/<case>.json`: a script of operations with deterministic ids and
  a clock (`start + step * n` for the n-th event stamped), and the
  expected events, state, state digest, and per-slot link counts.
- `tier3/<case>.json`: a camera and the expected render flags and scene
  digest. Optional for a second implementation.

## What an implementation must do

Tier 1. Parse the pack, replay every bit's ledger in `seq` order
(`created`, `presence`, `emitted`, `moved`, `passport`, `annotated`,
`destroyed`; `linked` and `unlinked` are derived and skipped), and
produce the canonical state:

```
{"scene": <container id>, "bits": [ ...sorted by id... ]}
bit: {"id", "position", "present", "color", "passport", "emissions", "links"}
```

written as JSON with no spaces, keys in that order, whole-number floats
as integers, non-ASCII unescaped. The state digest is SHA-256 over the
UTF-8 of that text, lowercase hex. `links[s]` lists `"<neighbor id>:<partner slot>"`
for every present neighbor at an offset where `slots.json` gives slot
`s` a partner, sorted. Then check the seal: SHA-256 of each bit's
passport text and events text against `manifest.hashes`; report the
mismatches sorted by id then file. With `did.json`, verify the Ed25519
signature in `manifest.signature.value` (base64url, 64 bytes) over
`{"scene", "ids" (sorted), "hashes" (keys sorted)}` with the public key
`x` (base64url) of the document's `assertionMethod`; report `verified`,
`forged`, `unresolved` (signed, no document), or `unsigned`.

Tier 2. Run the operations on an empty container with the given id and
clock, stamping every event with `bit`, `seq` (from 1), `time`, `frame`,
and the wrangler's `actor` and `cause` when set; report the event before
applying it. Emit the events, the state, its digest, and the link
counts, and compare.

## Running the Python implementation

```
python kit/python/run_kit.py conformance
```

Python 3.10 or later, standard library only. It prints one line per
case and exits non-zero on any tier 1 or tier 2 failure; tier 3 is
reported as skipped.

## Running the TypeScript implementation from the fixtures

```
npm test -- tests/conformance/kit.test.ts
```

## Regenerating the fixtures

```
npm run conformance:export
```

The exporter is deterministic except for the signing key in the signed
cases, which is minted fresh each run; its public half travels in
`did.json`, so the fixtures stay self-contained.
