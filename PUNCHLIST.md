# Punchlist: what the bit asks for from a thousand years out

Date: 2026-09-06. Status: proposed, unscheduled. Each item names the
check that would show it done. Rule of the list: standards over vendors,
files over services, no account needed to test.

| # | Item | Done when | Size |
|---|------|-----------|------|
| 1 | **Self-contained reader.** One dependency-free file (plain HTML or WebAssembly) that opens a `vpb-scene-pack/1` and shows any bit's passport and history; the SPEC text travels inside the pack. | The reference pack opens in a browser with the network off and Node absent; the digest it computes equals the repo's. | M |
| 2 | **Timestamped seals and key rotation.** A witness timestamp (RFC 3161 or a transparency-log inclusion proof) stored beside each signature; a signed chain from an old container key to its replacement. | A seal verifies after its DID page is taken down, using the witness alone; a rotated key verifies the old seals through the chain. | M |
| 3 | **A policy the bit carries.** A small document in the passport saying who may change it, what work it accepts, whether an agent may act; the sink enforces it before any event lands. | An agent over MCP is refused by a bit whose policy excludes it, and the refusal is in the ledger. | M |
| 4 | **Searchable memory.** A file-based index rebuilt from the ledger and passport; text first, vectors optional. | "When did anyone touch slot 1" answers in one call on the reference scene; the MCP server exposes it as a tool. | S |
| 5 | **Senses.** Readings from the physical bit (light, touch, temperature) land as annotations with units, and export as EPCIS sensor reports. | The twin fakes a reading, the ledger holds it, the export validates, the capture check accepts it. | M, hardware half waits on #72 |
| 6 | **Reproducible, signed releases.** Pinned reproducible build, a software bill of materials, release artifacts signed into a public transparency log. | Two clean machines build the same bytes from the same tag; the signature verifies against the log. | M, the log entry is Oscar's call |
| 7 | **glTF interchange.** Export a scene to glTF with per-node emission as a material extension; import back preserving ids in the passport. | The reference scene opens in Blender and a web viewer; a round trip keeps the digest. | M |
| 8 | **Accessibility.** Keyboard and screen-reader paths through the demos; a text rendering of any scene as a first-class view. | The passport page and the demos pass an automated accessibility audit with no critical findings; a scene reads aloud in order. | M |
| 9 | **Language-neutral conformance kit.** The conformance tests exported as fixtures: inputs, expected events, expected digests, runnable by any implementation. | A second implementation in another language passes the kit and produces the reference digest. | L |
| 10 | **Value, after the four answers.** Bearer or claim; who holds the spend key; what travels with the cube; whether an agent may spend. Then a `Vault` contract with a test-chain reference backend. | Two bits exchange test value, both ledgers agree, the seal verifies, no real money and no account. | L, blocked on the answers and a legal read |

Not on the list, by rule: any single vendor as a dependency, a token of
our own, hosted backends that need an account, another renderer.

Standing items from the programs, still open: parts for the physical bit
(#72), the on-camera measurement (#73), release 0.4.0 held for first
light, and the container ledger cost (Phase 16 journal).
