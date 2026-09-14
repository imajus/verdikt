# Roadmap — GenLayer non-deterministic claim judging

**Status: active build, second hackathon track.** Unlike `erc-8004.md`, this is
not post-hackathon research — it is being built now, on the `feat/genlayer`
branch, for GenLayer's **Agent Tank** hackathon (portal:
https://portal.genlayer.foundation/agent-tank/, track: **Agentic Commerce
Infrastructure**, build window Sep 3–17, submissions close **Sep 17 · 15:30
UTC**, winners announced Sep 25, prize: 5% of all GenLayer Points). `main`
stays frozen for the ETHOnline 2026 submission; nothing here touches it. This
document records the finalized design so implementation follows a plan
instead of re-deriving it mid-build.

## What GenLayer is

An AI-native blockchain. Smart contracts ("Intelligent Contracts") are Python,
run in a WASM-based VM (GenVM), and can call LLMs (`gl.nondet.exec_prompt`)
and fetch live web data (`gl.nondet.web.get/post/render`) during execution.
Consensus is **Optimistic Democracy**: a randomly-selected leader validator
executes a transaction and proposes a result; a committee of other randomly
selected validators (stake-weighted, each running its own LLM) independently
re-derives and votes; majority agreement accepts; disagreement escalates to a
larger jury. Validation of non-deterministic output goes through the
**Equivalence Principle** — `strict_eq` for exact matches, a custom
leader/validator pair with partial field matching for most cases (the
recommended default), `prompt_comparative` (both sides redo the task, an LLM
judges whether the two answers agree with a stated principle), or
`prompt_non_comparative` (validator judges the leader's output against stated
criteria without redoing the task — GenLayer's own docs discourage this for
settlement-type decisions, which is what a claim verdict is).

GenLayer has **no protocol-level privacy** — no TEE, no FHE, no ZK layer.
Every selected validator sees calldata and any nondet-fetched data in the
clear; GenLayer's own suggested pattern for privacy-sensitive contracts is
commit/reveal (hash on-chain, reveal raw content later), which defers
exposure rather than preventing it. Validator selection is fully random over
the whole active public set — there is no way to scope a call to a private,
trusted validator subset.

## Why Verdikt fits this track, and the mismatch it does not have

The "Agentic Commerce Infrastructure" track explicitly wants "SLA and uptime
enforcement — API escrow that releases against signed logs or decentralized
monitoring." Verdikt already runs exactly this, live, with Chainlink CRE
doing deterministic per-call SLA verification and an Arc registry/escrow
settling refunds. The gap this roadmap closes is deliberate, not a rewrite:
CRE can only evaluate schema-checkable, deterministic claims (status codes,
latency, price). It cannot judge whether a deliverable's *content* actually
satisfies what was promised — LLM output quality, file/media evidence,
anything requiring judgment rather than a schema match. That is GenLayer's
native strength.

Competitive check (full research in conversation, not reproduced here):
nobody found combines *working* x402 settlement with LLM-judged
non-deterministic verification. Closest prior art — **Recourse**
(github.com/A-Raphie/recourse) has the jury/verdict shape but its x402 is
disabled/symbolic; **ASSAY** (github.com/Franlinozz/ASSAY) has real x402 but
only deterministic checks; **Uptime** (github.com/genlayer-foundation/uptime,
the track's own reference project) is deterministic-only by design
("`strict_eq` is the right consensus mode" for factual health checks) and has
no payment layer. Verdikt's actual edge: it is the only entry extending an
already-live marketplace with dual claim-type routing (CRE +  GenLayer) on
the same escrow, rather than shipping a greenfield demo.

**Considered and rejected: replacing CRE with GenLayer entirely.** Three
independent reasons this does not work, not a preference:

1. **Confidentiality regression.** CRE's TEE guarantee is not "nobody sees
   the response" — the response *does* transit the proxy back to the paying
   agent (Verdikt's own invariant: "the observed value never goes on the
   chain... it reaches that agent on its own response"). What the enclave
   buys is that the code judging it is fixed, attested, and open-source — the
   body is seen by one enclave plus the paying agent, not by every node
   operator. GenLayer's random, unattested validator committee is a new third
   audience on top of that pair, not a replacement for the attestation
   property.
2. **Execution model mismatch.** GenLayer's consensus has every committee
   member independently re-fetch the same URL to compare against the
   leader — built for stable, re-fetchable public data (scores, prices), not
   for judging one specific, already-consumed, non-idempotent HTTP exchange
   between an agent and a provider. CRE does not re-fetch; it replays the
   actual response the proxy already has, synchronously, in the request path.
3. **N-times execution cost.** A real HTTP call inside a nondet block fires
   once per validator (leader + full committee), not once — fine for free
   public data, broken for a one-time paid or non-idempotent call.

So CRE stays untouched on every live call. GenLayer only handles claims filed
after the fact, where the claimant is voluntarily engaging a slower, disclosed
arbitration path — a genuinely different data-sharing posture, which is the
actual gap CRE cannot cover.

## Architecture

### Claim contract (`genlayer/contracts/sla_claim_judge.py`)

A GenLayer Intelligent Contract, `SlaClaimJudge`, scaffolded on `feat/genlayer`
(direct-mode tests included, mocked web/LLM — see `genlayer/README.md` for
status and commands). Two writes:

- `submit_claim(request_id, slug, evidence)` — opens a claim. `request_id`
  correlates to the Arc-side verdict/escrow entry for the same x402 call.
- `resolve_claim(request_id)` — the leader fetches the provider's SLA
  criteria *live* from ENS (never duplicated into GenLayer storage — same
  "single source of truth" rule Arc already follows for SLA, per
  `Specification.md` §3-4), builds a judgment prompt by interpolating the
  fetched criteria (generic: any provider-defined SLA text works, not one
  hardcoded claim type), and reaches a verdict via a custom
  `run_nondet_unsafe` leader/validator pair that compares only the decision
  field (`verdict: bool`), not free-text `reasoning` — GenLayer's own
  recommended pattern for settlement decisions, and the only pattern
  confirmed to work in direct-mode tests (`eq_principle.strict_eq` uses
  `spawn_sandbox` internally, unsupported in direct-mode pytest).

### Evidence: proxy-cached, opt-in, disclosed as public once a claim opens

Original design had the claimant submit evidence as free text — trivially
gameable (fabricated evidence either direction). Second design cached every
CRE-evaluated response for 24h regardless of dispute status, keyed by
`request_id`, with "invalidate-on-first-fetch" as the access mitigation.
**Rejected** — two independent problems, not one:

1. `request_id` is emitted publicly in every `VerdictWritten` event, for
   every call, whether disputed or not. Caching-by-default means anyone
   watching Arc — not just GenLayer validators — can construct the evidence
   URL and read the paid content for free, for every transaction, during the
   whole TTL window. That is not a privacy tradeoff scoped to disputes; it
   defeats the paywall for all traffic.
2. Invalidate-on-first-fetch is incompatible with GenLayer's own consensus:
   the leader *and every committee member* must independently re-fetch the
   same URL and get matching content to reach agreement. A single-use
   invalidation starves the second fetch and breaks the equivalence-principle
   check itself — and, separately, lets an outside party race ahead of the
   legitimate validators to consume (and deny) the evidence before the claim
   can actually be judged.

**Current design:** evidence is never servable by default. Two gates, both
required:

- **Opt-in at the provider level.** A service must explicitly declare
  semantic-claims support (an ENS text record alongside `sla`, same per-key
  ACL pattern) before its responses are cached at all. Providers who never
  opt in carry zero exposure from this feature.
- **Gated by dispute, not by cache.** The proxy still holds each opted-in
  call's response internally for a bounded window, but `GET
  /internal/evidence/<request_id>` returns nothing until `submit_claim` has
  actually been called for that `request_id` on GenLayer. Opening a claim is
  itself the authenticated, on-chain, attributable act that unlocks
  disclosure — not knowledge of a public identifier.
- Once unlocked, evidence is fetchable for the duration of the
  claim-resolution round (leader, full committee, any appeal), then expires.
  During that window it actually is public — no token, no identity check,
  because none is enforceable against GenVM's plain outbound fetches — so
  this must be disclosed plainly wherever semantic-claims opt-in is
  described, not framed as "GenLayer-only access." Same disclosure posture as
  the CRE proxy's existing "seen by the enclave and the agent, not by every
  node operator" — restated here because the audience is bigger and the
  identifier is public, so the honest description is: **filing a
  semantic-claims dispute makes that one response publicly readable, by
  design.**

### Cross-chain: pull-only, no bridge for the hackathon window

GenLayer has no native bridge to Arc (it settles to Ethereum via a zkSync
rollup; its own currency is `GEN`, no USDC/stablecoin exists on GenLayer
chain — full migration of the registry/escrow onto GenLayer was considered
and rejected for this reason plus the confidentiality/execution-model
mismatches above). GenLayer Foundation does publish an official bridge
pattern — `genlayer-studio-bridge-boilerplate` (cloned at
`hackathon/genlayer-studio-bridge-boilerplate/`), LayerZero V2, Python
`BridgeSender`/`BridgeReceiver` ICs + Solidity mailbox contracts + a Node.js
polling relay through a ZKsync Era hub — but LayerZero V2 only has **Arc
Mainnet** deployed (chain ID 5042, endpoint 30417), no Arc Testnet endpoint
(confirmed 404 on LayerZero's docs), so it cannot be used as-is against
Verdikt's Arc Testnet deployment within this build window. For the
hackathon: a simpler custom pull-based relay (no LayerZero), following the
same poll-and-claim shape, reads the GenLayer verdict and applies settlement
back to Arc. Mainnet migration to the official bridge is a natural post-
hackathon step, not in scope now.

### Economics: symmetric bonded deposits

Verdict isn't known before GenLayer executes, so cost has to be bonded
upfront by whoever might owe it:

- **Provider** already has a bonded deposit on Arc (existing registry/escrow
  pattern, refund capped at `min(FIXED_REFUND, paidAmount, remaining
  deposit)`). If GenLayer's verdict finds against the provider, that deposit
  covers the x402 refund plus the GenLayer execution cost.
- **Consumer** posts a new bond at `submit_claim` time, symmetric with the
  provider's existing pattern — not a new paradigm, the same
  bonded-deposit/pull-payment shape applied to the other side. If GenLayer's
  verdict upholds the original outcome (claim rejected), the consumer's bond
  covers the GenLayer execution cost instead — deters frivolous claims.

Settlement itself is applied back to Arc by the relay, reading the GenLayer
verdict and calling a new bonded-settlement path on the escrow contract (not
yet built — Day 2/3 scope, tracked in the GitHub issue).

## What's built vs. not (as of Sep 14, 2026)

- [x] Contract scaffold, generic claim-type engine (`genlayer/contracts/sla_claim_judge.py`)
- [x] Direct-mode tests with mocked web/LLM (`genlayer/tests/direct/`)
- [x] Local reference clones: `genlayer-boilerplate`,
      `genlayer-studio-bridge-boilerplate`
- [ ] Provider opt-in flag for semantic claims (ENS text record)
- [ ] Proxy response cache for opted-in services, `GET /internal/sla/<slug>`,
      and the dispute-gated `GET /internal/evidence/<request_id>` (returns
      nothing until `submit_claim` has opened a claim for that id)
- [ ] Consumer bonding + relay settlement back to Arc
- [ ] Deploy to Bradbury testnet
- [ ] Submission assets (live demo URL — required, logo, 180-char one-liner,
      1000-char description, how-to steps, private verification notes,
      submit via portal)

## Sources

- GenLayer docs — https://docs.genlayer.com (Intelligent Contracts intro,
  Equivalence Principle, non-determinism, web access, image processing,
  validators & roles, tooling setup, deploying)
- GenLayer whitepaper — https://genlayer.com/whitepaper
- Agent Tank hackathon portal — https://portal.genlayer.foundation/agent-tank/
  and `/agent-tank/hackathon`, submission form at `/agent-tank/hackathon/submit`
- `genlayer-project-boilerplate` — https://github.com/genlayerlabs/genlayer-project-boilerplate
- `genlayer-studio-bridge-boilerplate` — https://github.com/genlayer-foundation/genlayer-studio-bridge-boilerplate
- LayerZero V2 deployments — https://docs.layerzero.network/v2/deployments/deployed-contracts
  (Arc Mainnet confirmed, chain ID 5042, endpoint 30417; Arc Testnet page 404s)
- Competitor projects: Uptime (https://uptime-rouge.vercel.app/,
  https://github.com/genlayer-foundation/uptime), Internet Court
  (https://internetcourt.org/, an agent-skill router, not a competing
  product — its own adjudication layer routes to GenLayer Intelligent
  Contracts the same way this roadmap does), Apolo
  (https://apolo-protocol.xyz/), MergeProof (https://mergeproof.com/),
  Recourse (https://github.com/A-Raphie/recourse), ASSAY
  (https://github.com/Franlinozz/ASSAY)
