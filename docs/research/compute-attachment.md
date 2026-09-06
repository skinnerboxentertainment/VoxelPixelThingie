# Attaching compute and storage to a bit: a field survey

Date: 2026-09-06. Status: research, not a plan. Nothing here names a
default vendor; the design picks contracts first and treats vendors as
interchangeable backends behind them.

## The question, in the field's terms

Oscar's ask: could a unique instance of a bit have storage and computing
capacity attached to it, the way distributed agentic processing and
storage attach to unique tokens, and could a bit be a computing unit?

Stripped of any one vendor, that is five things the industry already
names and sells:

1. A verifiable **identity** for the unit.
2. **Compute bound to an identity**, on demand: the virtual actor and
   durable execution pattern.
3. **Storage addressed by content**, so state outlives any host.
4. An **attestation log**, so strangers can check the unit's history
   without trusting its host.
5. A **physical bridge**, so a thing on a desk resolves to the identity.

The bit already has the seams for all five: a UUID v7 id, a web URI under
the project namespace (ADR 0008), a free-form passport (SPEC.md §9.5), an
append-only ledger with actor and cause (§9.2), replay across stores with
one digest (§10.9), and a passport page with a QR code (Phase 10).

## Method

Each category lists the leading options across the whole field, then
ranks them on two axes: adoption (who actually runs it, at what scale)
and substance to hype (does the money and the usage match the talk).
Claims are labeled Verified (read today from a primary or reporting
source, listed under Sources) or Trusted (industry knowledge, not
re-checked today). Tiers:

- **A**: broadly adopted, substance well ahead of hype. Safe contract
  targets.
- **B**: real and growing, but noisy or young. Fine as a backend, not as
  a contract.
- **C**: niche or speculative. Watch, do not build on.

## 1. Identity of the unit

| Option | Adoption and hype | Tier |
|--------|-------------------|------|
| W3C Verifiable Credentials 2.0 | Recommendation since 15 May 2025 (Verified). The EU digital identity wallet work tracks it. | A |
| W3C DIDs 1.1 | Candidate Recommendation, 5 March 2026, implementations invited (Verified). `did:web` and `did:key` are the most implemented methods (Trusted). | A for `did:web`, B for the rest |
| GS1 Digital Link | Mandated carrier for the EU battery passport from 18 February 2027, with a three-tier access model that later product passports will copy (Verified). | A |
| C2PA content credentials | Shipping in cameras and creative tools (Trusted). Provenance for media, not for objects. | B |
| NFTs as identity | Real markets, heavy hype. For this purpose an NFT is an id, a pointer, and a ledger, which the bit already is. | B |

**Contract:** a bit's identity is a `did:web` under the project namespace
that resolves to a document naming its passport, ledger, and keys; the
physical form is a GS1 Digital Link URI. No chain required.

## 2. Compute bound to an identity

| Option | Adoption and hype | Tier |
|--------|-------------------|------|
| Durable execution (Temporal, AWS Durable Functions, Cloudflare Workflows, Vercel Workflow DevKit, Inngest, Restate, DBOS) | Crossed into the early majority in late 2025; Temporal raised $300M at $5B in February 2026 with 9.1 trillion actions run (Verified, reported). Cloudflare Workflows GA since April 2025 (Verified). | A for the pattern; Temporal and the cloud-native ones A, Restate and DBOS B |
| Virtual actors (Microsoft Orleans, Akka, Dapr actors, Erlang OTP) | Decades of production use; Dapr is a CNCF graduated project (Trusted). SPEC.md §5.1 already calls the addressing unit a grain, Orleans's word. | A |
| Cloudflare Durable Objects | One stateful object per id with its own SQLite store; on the free plan, 100k requests and 5 GB total (Verified). | A |
| Serverless functions (Lambda, Cloud Functions, Workers) | Universal (Trusted). Stateless; needs a store beside it. | A |

**Contract:** an `Actor` per bit id with `handle(job)` and its own state,
implemented first in process as the reference, the way `Grid` preceded
`FlatGrid`, then behind any durable-execution or durable-object backend.

## 3. GPU compute, when a job needs one

The market has four shapes (Verified, reported): hyperscale neoclouds for
sustained training (CoreWeave, Nebius); on-demand specialists with
per-second rates (Lambda, Runpod); serverless inference behind a
function-call API (Modal, fal, Replicate, Baseten, Together); and
decentralized physical infrastructure networks (Aethir, Render, Akash,
io.net). Consolidation is under way: Cloudflare acquired Replicate in
November 2025, Modular acquired BentoML in February 2026 (Verified,
reported). A Microsoft source is quoted saying half its GPU clients now
buy through APIs rather than reserved instances (Trusted, hearsay).

| Shape | Tier |
|-------|------|
| Serverless inference behind a function-call API | A as the contract target: any of them is a backend |
| On-demand specialists | A for cost, B for lock-in |
| Hyperscale neoclouds | A, irrelevant at this project's scale |
| DePIN compute | B: reported revenue is real (Aethir ~$150M ARR claimed, Render ~$38M in January 2026, Akash ~$4M run rate at ~80% utilization), but the reporting comes from crypto-adjacent outlets with a stake, so Trusted at best. Defer until there is a stranger to pay. |

**Contract:** `submit(job) → { id, status(), result() }` over HTTP, which is
the shape every serverless platform already exposes.

## 4. Storage that outlives the host

| Option | Adoption and hype | Tier |
|--------|-------------------|------|
| S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2) | The de facto API (Trusted). | A |
| Content identifiers (IPFS CIDs) | The format is A: a CID names bytes anywhere. The public network is B: pinning services carry it. Already integrated (Phase 6). | A / B |
| Filecoin, Arweave, Storj | Real storage, token economics attached (Trusted). | B |
| Git hosting, browser OPFS | Already in the stack (Phases 6 and 8). | A |

**Contract:** `put(bytes) → cid`, `get(cid)`, with the S3 API and a
pinning service as the first two backends. Results larger than a
passport's 256 KiB go here; the event carries the CID.

## 5. Attestation, so strangers can check

| Option | Adoption and hype | Tier |
|--------|-------------------|------|
| Sigstore and its Rekor transparency log | Over 101 million entries from more than 33,000 open source projects (Verified, reported). Identity-based signing with an append-only public log. | A |
| IETF SCITT | Architecture at draft 22, standards track, converging with Sigstore on COSE (Verified). | B, rising |
| Blockchain anchoring | Works; the DePIN guests on the Radoff streams are right that its job is to attest proofs about a device, not to hold the device. | B |
| The project's own seal and digest | Exists (§10.9). Trustworthy only if you trust the store. | the gap |

**Contract:** signed seals under the container's `did:web` key, registered
in a transparency log. Sigstore's model is the target; SCITT when it
lands.

## 6. Agents attached to a bit

| Option | Adoption and hype | Tier |
|--------|-------------------|------|
| Model Context Protocol | Donated to the Linux Foundation's Agentic AI Foundation in December 2025, co-founded by Anthropic, Block, and OpenAI with Google, Microsoft, AWS, and Cloudflare behind it; about 97 million monthly SDK downloads by March 2026 (Verified, reported). | A |
| Agent-to-agent protocols (A2A) | Complements MCP, younger (Verified, reported). | B |
| Agent SDKs (Claude Agent SDK, OpenAI Agents SDK, LangGraph, Google ADK) | All real; all sit on MCP for tools (Trusted). | A as backends |

**Contract:** the scene is an MCP server. A bit's history, passport,
emissions, and job submission are tools; any agent runtime attaches
without a vendor choice on our side. This is the vendor-neutral answer
to "agentic processing attached to a unit."

## 7. Local compute, the cheapest attachment

WebGPU ships by default in Chrome, Safari 26, Firefox 141 and later, and
Edge, with first-class compute shaders (Verified). The Three.js demo
already runs on it. On-device models remove the per-interaction cloud
cost that makes such things fragile (a point two Radoff guests made).
Tier A. The first workload is the LED frame: same bytes as the CPU path,
which is its oracle.

## 8. The physical bridge

| Option | Adoption and hype | Tier |
|--------|-------------------|------|
| GS1 Digital Link in a QR | Regulatory mandate from 2027 (Verified). The passport page already answers to it. | A |
| NFC with a secure unique tag (NTAG 424 DNA class) | Standard for anti-counterfeit authentication (Trusted). Answers "is this cube that bit" with a signed challenge, which a QR cannot. | A |
| Tokenized collectibles vaulting | The Radoff collectibles episode: the bridge, not the chain, was the years of work. | B |

## What the Radoff library adds

Read on 2026-09-06 from the distilled units and transcripts of Oscar's
livestreams with Jon Radoff:

- Distributed compute predates blockchain (SETI@home, Folding@home); the
  token is an incentive layer, not the capability.
- Koii's loop is work, then audit, then reward. The bit's ledger has the
  first and last; the audit is the project's oracle discipline applied
  per job.
- Distributed is not decentralized: recourse comes from proofs, which is
  what signed seals in a transparency log provide.
- Chains attest devices; they do not hold them. EPCIS already carries the
  where and the what.
- The physical-to-digital bridge is the bottleneck, not the token.
- A digital twin, in the original spacecraft sense, is a full model tested
  before the hardware exists and fed real data afterward. The WLED
  emulator is one.
- Agents want machine-readable docs first; a vector index of SPEC, ADRs,
  and oracles would let an attached agent orient in one read.

## Shape of a spike, if one is wanted

1. Identity with recourse: `did:web` per bit; the seal signed; a stranger
   verifies a bit's history from the IPFS copy alone.
2. Work, audit, reward as events: request, result with CID, audit naming
   the check that passed; the EPCIS export shows all three; the digest
   holds across four stores.
3. Local first: a WebGPU compute path producing the LED frame, byte-equal
   to the CPU path.
4. Actor contract with an in-process reference, then one durable backend
   chosen by the ranking above, never by what happens to be wired in.
5. The scene as an MCP server.
6. The twin named as such in the docs.

Excluded by rule: any provider reachable through work accounts, and any
token layer until there is a stranger to pay.

## Sources

- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/) and [the VC 2.0 family as Recommendations](https://self-issued.info/?p=2694)
- [W3C invites implementations of DIDs 1.1, March 2026](https://www.w3.org/news/2026/w3c-invites-implementations-of-decentralized-identifiers-dids-v1-1/)
- [Digital Product Passport for batteries, February 2027](https://www.bluestonepim.com/blog/digital-product-passport-for-batteries) and [the DPP timeline](https://traceable.digital/resources/blog/eu-digital-product-passport-deadlines-the-complete-2025-2030-timeline/)
- [Durable execution in 2026, Temporal, Inngest, DBOS, Restate](https://www.reactify-solutions.com/articles/durable-ai-agents-2026) and [Dapr vs Temporal](https://oneuptime.com/blog/post/2026-03-31-dapr-vs-temporal-workflow-comparison/view)
- [Cloudflare Durable Objects pricing and free plan](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [DePIN revenue pivot](https://blockeden.xyz/blog/2026/04/12/depin-revenue-pivot-token-subsidies-ai-compute-akash-render-ionet/) and [Render vs Akash vs io.net vs Aethir](https://ownyourmind.ai/tokenomics/render-vs-akash-vs-ionet/)
- [Serverless GPU platforms compared, 2026](https://www.buildmvpfast.com/blog/serverless-gpu-ai-inference-platform-comparison-2026) and [GPU cloud comparison](https://comparegpuclouds.com/)
- [Anthropic: donating MCP and establishing the Agentic AI Foundation](https://anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation) and [MCP adoption statistics 2026](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol)
- [WebGPU ships in all major browsers](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/)
- [Sigstore transparency log research dataset](https://openssf.org/blog/2025/10/15/announcing-the-sigstore-transparency-log-research-dataset/) and [IETF SCITT architecture draft](https://datatracker.ietf.org/doc/draft-ietf-scitt-architecture/)
- Jon Radoff livestream library, distilled units and transcripts, local copy read 2026-09-06.
