# Punchlist 2: what the rebuilt bit asks for, a thousand years out

Date: 2026-09-06. Status: proposed, unscheduled. The first punchlist was
built as PLAN-4 (Phases 17 to 25). This list is what the thing, rebuilt
with everything it now has, would send back next. Same rule: standards
over vendors, files over services, no account needed to test. Each item
names the check that would show it done.

| # | Item | Done when | Size |
|---|------|-----------|------|
| 1 | **Formats that describe themselves and migrate.** A JSON Schema for every `vpb-*/n` format, shipped inside the pack and the reader; an upgrader per version step with fixtures; the system descriptor carried in the pack. | A `/1` pack opens under a reader that only speaks the newest version, through the chain; every published pack validates against its schema; the reader can say what format it holds without opening it. | M |
| 2 | **Witnesses that renew.** A re-witness statement that wraps the previous proof and the current seal in a new timestamp, so trust moves forward as authorities die (the evidence-record pattern). | A seal witnessed in year one verifies in year ten with only the year-ten authority trusted, through the chain of renewals; a broken link in the chain is named. | M |
| 3 | **Signature agility, post-quantum included.** The seal's `alg` becomes a real choice: a second algorithm behind the same contract, hybrid signing with both, verification of either, in TypeScript and in Python. | A hybrid seal verifies under a verifier that trusts only the second algorithm; the conformance kit gains the cases; Python passes them. | L |
| 4 | **Compaction with proof.** A compaction record carrying a root hash over the events it dropped, so an archived tail can be checked against the compacted scene. | An archive of the dropped tail verifies against the compacted scene's record; one altered archived event fails with the seq named; the state digest is unchanged by compaction. | S |
| 5 | **Repair from any mirror.** A scene on several stores; a repair that reads the manifest's hashes, finds missing or corrupt files on one store, and restores them from another, by hash. | Three files deleted and one altered on a store; repair restores them byte for byte from a mirror; digest equal; a mirror serving wrong bytes is refused. | S |
| 6 | **One core, every host.** The model, replay, seal, and render self-tests as one WebAssembly module, run in the browser, in Node, and from Python. | The module passes all three conformance tiers in all three hosts; the Python runner reports tier 3 from the module rather than skipping it. | L |
| 7 | **Many bodies.** A frame of physical bits: per-bit addressing across one LED network, discovery of devices, one device actor per bit, senses back from each. | Two twins on one network light as two bits and report as two device actors; the ledger keeps them apart; the driver finds them without configuration. | M, hardware half waits on #72 |
| 8 | **Delegation.** A controller signs a capability for an agent: what it may do, on which bits, with what limits, until when; the sink checks it like a policy. | An agent with a capability acts within its limits; expired or over-limit is refused with the record; the capability's signature is checked against the controller's key. | M |
| 9 | **Audits that sign.** The actor countersigns every audit with its own key; a reward is refused unless the audit's signature verifies. | A forged audit yields no reward; the ledger shows the refusal; the durable and in-process pools both do it. | S |
| 10 | **Rules from senses.** A bit reacts to its own readings by rules in its passport (threshold, then emission), recorded as events whose cause names the rule. | The twin's temperature crosses a threshold; the bit's emission changes; the ledger's cause is `rule:<id>`; the policy can forbid rules. | M |

Not on the list, by rule: any single vendor, any token of our own, any
service that needs an account to test, and value, which waits on the
four answers.

Still open from the programs before: parts for the physical bit (#72),
the on-camera measurement (#73), release 0.4.0 held for first light, the
OpenEPCIS capture of sense events, and the descriptor's commit.
