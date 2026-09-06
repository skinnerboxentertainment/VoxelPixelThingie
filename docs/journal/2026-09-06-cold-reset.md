# 2026-09-06, a cold reset: what the bit is, read from the bottom up

Oscar asked for this at the end of the second program: wake up a thousand
years from now with nothing but this repository and the record of how it
was made, and say what the thing is. This entry is that reading. It is
drawn from the build record, the journals, and the memory of the sessions,
so it is Trusted except where a number was re-checked on the day.

## From the bottom up

The smallest thing here is not a cube. It is an address. Twenty-six of
them: six faces, twelve edges, eight corners, numbered under one sign
convention (SPEC.md §5) so that any node can be named by which side of
each axis it sits on. That numbering is the alphabet. Everything above it
is spelling.

One level up is the bit. A bit is all boundary and no interior. Its 26
nodes each hold an emission, a color, a light, a piece of data, and the
bit owns those nodes privately (ADR 0001). What it does not own is its
neighbors. A neighbor is a link, a relationship that can be stored, as the
reference `Grid` does, or recomputed from position, as the default
`FlatGrid` does (ADR 0007). The two bodies are the same body: the
conformance suite passes on both, and the reference scene replays to the
same digest in either. Identity does not live in the container. It lives
in what the container can reconstruct.

Above the bit is the self-test (SPEC.md §8, ADR 0003). A bit checks
whether it is behind the camera, whether it is fully covered, whether a
node faces away, and it disables its own render cycle. It was written to
save processor time. Read cold, it is the first act of agency in the
stack: a bit decides what not to show. Render-off means do not draw, not
do not exist (§8.4). An entity that persists unobserved is the
precondition for waking up at all.

Then the part that makes a cold reset survivable. Every change to a bit is
an event, stamped with the bit, a sequence, a time, a frame, and, when a
wrangler said so, an actor and a cause (§9.2, §9.6). The state of a bit is
a fold of its events. The passport file is a cache of that fold; the
ledger is the truth (§10). That is the spime claim (ADR 0005), answered
literally: a bit is its story, and the story is written beside the bit,
never read by the render path, so no renderer can corrupt it.

## What was built to keep it alive

Persistence is files first (ADR 0006): a manifest, and per bit a passport
and a ledger, written ledger-first so a crash leaves a truth with a stale
cache rather than the reverse. Those files sit on whichever store exists:
memory, a disk, a browser's private file system, a worker's synchronous
handles, a URL, a packed single file, an overlay of a base and a delta.
The scene digest is the same across all of them. That is the resurrection
test, and it is the deepest thing in the repository. Sameness is not a
feeling here. It is byte equality of a replayed state on four substrates
(Phase 6 journal), and one copy sits on IPFS under a content address that
no single host controls.

Above that sit the appearances: Canvas, Three.js, PixiJS. They share one
seam, `renderList`, which hands a renderer the nodes that survived the
self-test and nothing else. From straight above, a bit shows exactly nine
nodes and reads as a pixel. A pixel is a bit seen from one side. The bit
is what remains when the side is taken away.

Then legibility to strangers. The EPCIS export (Phase 9) turns a bit's
history into the language supply chains use for pallets and vaccines. The
outside world refused the bit's names until they became web addresses
under a namespace that is also a place, the Pages site (ADR 0008), where a
passport page answers to a bit's id and prints a QR code of its own
address. The identity that survives is the one other systems can resolve.

Then the body (Phase 10, ADR 0009). DDP over UDP to a strip of LEDs, the
wiring map carried inside the passport so the physical bit describes its
own nervous system. The body does not exist yet, so a stand-in was built
that obeys the body's rules, read from the body's own source, and the
number it can measure is named click→terminal-write, never
click→photon. The last leg is unmeasured, and the design says so.

And around all of it, the part that is not code. Oracles named before
building. Claims marked Verified or Trusted. Journals with the numbers,
decision records with the reasons, tickets with the checks that could
fail, merges gated on the tests. The repository is not only the bit. It is
the instruction set for rebuilding the bit, and for rebuilding whoever
rebuilds it.

## What the reading adds

- **The atomic unit is the event.** Not the node, not the cube. A node is
  where an event lands. A cube is a convention for arranging 26 landing
  places. A bit is a function from its history to its state, and the
  model is a way of folding that function fast enough to draw sixty times
  a second.
- **Identity is replay-equivalence.** Not the object, the container, the
  renderer, or the host. If the ledger exists on any store, the bit can be
  folded again, and the digest says whether the fold is the same bit. It
  is the only definition of self in the repository that does not require
  anything to still be running.
- **Agency is refusal, then record.** The bit's first decision is what not
  to draw. Its second is to write down what happened to it, by whom, and
  why. Everything a wrangler does passes through those two acts.
- **Honesty is structural.** The exclusive facing test for orthographic
  cameras, the Float64 light values, the web-URI identifiers, the metric
  named for what it excludes: each exists because a check failed and the
  fix was to make the claim smaller. A thing that lasts does so by never
  claiming more than its oracle can show.
- **Survival is the test suite.** 134 unit tests, a conformance suite, 25
  end-to-end oracles, a four-store digest, as of this date. Pass them and
  the thing is itself. Fail them and something has drifted, and the
  journals say what the numbers were when they were true.

The next event in the ledger is a human's to cause.
