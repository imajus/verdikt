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

### SLA schema compatibility: a new clause type, not a new document

"CRE stays untouched" needed a defined compatibility strategy before any of
this could be built — it wasn't automatic. `packages/sla/schema.json` uses
`oneOf` across exactly three known clause types (`schema`, `latency`,
`priceRange`), each `additionalProperties: false`. A clause with an unknown
`type` matches none of the three branches, so the whole SLA document fails
validation, and `evaluate()`'s own doc comment is explicit about the
consequence: "Throws on a malformed SLA... so the caller falls back to
`evaluateStatusOnly`" — losing every deterministic clause, not just failing
to add the new one. Adding a semantic clause naively would have broken every
provider's existing enforcement the moment they added one.

**Fix, implemented and tested on `feat/genlayer`:** a fourth `oneOf` branch,
`"type": "semantic"`, with its own dedicated field, `criteria` (string, the
binding judgment text) — not the existing `description` field, which stays
decorative on every clause type including this one; reusing it would have
made the same field name mean "decoration" on three clause types and
"binding promise" on the fourth. `clauses.js`'s `evaluateClause` gained a
`case 'semantic'` that always returns `pass: true` — CRE recognizes the
clause as schema-valid and includes it in the per-call clause-result list,
but never enforces it, so a mixed SLA's deterministic clauses still get a
real PASS/FAIL/DOWN verdict unaffected by whether the semantic clause would
actually hold. GenLayer's `resolve_claim` (below) filters `sla.clauses` for
`type === 'semantic'` and judges each one's `criteria` on dispute — the two
engines partition the same document by clause type, neither touches the
other's clauses. Verified: `packages/sla`'s 88-test suite (20 vectors,
including a new mixed-SLA case) passes unchanged plus the new case, and the
package's own self-check (`assertSchema(META_SCHEMA)` at module load) accepts
the new branch without touching the supported-keyword subset.

**Provider opt-in stays a separate concern from schema validity.** A provider
can publish a syntactically valid `semantic` clause without ever setting the
evidence-caching opt-in flag (below) — schema/parse validation must stay pure
and dependency-free (`packages/sla` bundles into the CRE workflow, no I/O),
so it cannot check an ENS flag to decide whether a clause is *allowed*, only
whether it is *well-formed*. A semantic clause published without the opt-in
flag is well-formed but unenforceable — no evidence will ever be cached to
adjudicate a dispute against it. That is a dashboard/SLA-editor warning to
surface at authoring time, not a schema-level constraint.

### Claim contract (`genlayer/contracts/sla_claim_judge.py`)

A GenLayer Intelligent Contract, `SlaClaimJudge`, scaffolded on `feat/genlayer`
(direct-mode tests included, mocked web/LLM — see `genlayer/README.md` for
status and commands). **Caveat, stated plainly:** unlike the `packages/sla`
fix below, this contract could not be executed in this environment — the
sandbox has no real PyPI/GitHub network access, so `pip install -r
genlayer/requirements.txt` fails on SSL/DNS. The tests are written against
the same API patterns already confirmed working in
`genlayer-project-boilerplate` (`run_nondet_unsafe`, `direct_vm.mock_web`,
`mock_llm`), but treat this as reasoned-through, not test-verified, until it
actually runs against real tooling — that's still Day 2/3 work.

Two writes, redesigned twice after review (see below for why):

- `submit_claim(request_id, slug, clause_id)` — opens a claim for one
  specific semantic clause and **freezes its `criteria` text** from ENS at
  this moment, via an exact-match (`strict_eq`-equivalent) nondet fetch. Not
  re-fetched later: a provider editing their SLA mid-dispute must not be able
  to retroactively change what is being judged — the same failure mode
  `packages/sdk/registry.js`'s `failedClause` hash already guards against on
  the deterministic side ("a non-zero hash matching nothing, meaning the
  provider has edited its SLA since"). No more free-text `evidence` argument
  here — see the evidence envelope below for where that content now comes
  from and why.
- `resolve_claim(request_id)` — fetches the evidence envelope (below), and
  either returns `UNDETERMINED` with a reason (envelope missing, unsupported
  content type, transport failure) or builds a judgment prompt from the
  *frozen* criteria plus the envelope's request/response fields, routing to
  `exec_prompt(images=[...])` for image evidence or plain text otherwise.
  Reaches a verdict via a custom `run_nondet_unsafe` leader/validator pair
  comparing only the decision field (`outcome: "MET"|"BREACH"|"UNDETERMINED"`
  now, not a bare `bool`), never free-text `reasoning` — GenLayer's own
  recommended pattern for settlement decisions, and the only pattern
  confirmed to work in direct-mode tests (`eq_principle.strict_eq` uses
  `spawn_sandbox` internally, unsupported in direct-mode pytest).

### Evidence envelope: what gets judged, and what doesn't

A response body alone isn't sufficient evidence — judging whether a
deliverable satisfies a clause needs the request that produced it too, and a
truncated or unsupported body must not be silently judged as if it were
complete. Checked against the real code rather than assumed:

- `proxy/src/router.js`'s `verified()` builds the CRE trigger payload from
  `providerUrl` (full path + query, via `upstream.toString()`), `method`,
  the payment, and `sla` — **no request body field is passed to the workflow
  at all today**, even though the proxy has it (`await request.arrayBuffer()`
  for non-GET/HEAD). The envelope reflects this honestly (`request.body:
  null`) rather than inventing data that was never captured; fixing that gap
  is a separate, larger change to the CRE trigger payload, not assumed here.
- `cre/workflows/verify/workflow.ts:162` truncates the relayed body to
  20,000 chars. The comment attributes this to "the DON consensus observation
  is capped (25kb in simulation)" — but the DON-signed report
  (`VERDICT_REPORT_PARAMS`) never carries the body at all, only
  `outcome/payer/amount/clauseHash`, and the truncation is applied to
  `finish()`'s payload, a direct enclave→proxy POST via `callbackUrl` that
  never crosses DON consensus. The stated reason doesn't match the code path
  being constrained. Flagging precisely rather than fixing blind: this needs
  its own look at `workflow.ts` before the evidence cache can safely assume
  it has the full body — caching a pre-truncated body would silently omit
  exactly the material a semantic clause turns on.

**Envelope shape** (served only once a claim unlocks it — see below):

```json
{
  "requestId": "0x…",
  "slug": "acme-flights",
  "request": { "method": "GET", "url": "https://…", "body": null },
  "response": {
    "status": 200,
    "contentType": "application/json",
    "body": "…",
    "bodyEncoding": "utf8"
  },
  "cachedAt": 1234567890
}
```

Supported `contentType`s: `application/json`, `text/plain`, `text/html`
(judged as text) and `image/png`, `image/jpeg` (judged via
`exec_prompt(images=[...])`, confirmed to accept raw bytes). Anything else —
missing fields, `response.status: null` (a transport failure, not a semantic
dispute), an unrecognized content type, a body the truncation bug may have
cut mid-content — makes the envelope **unsupported**, and `resolve_claim`
returns `UNDETERMINED` with a stated reason rather than defaulting to
`MET` or `BREACH` against either party. `_envelope_unsupported_reason` is a
pure function of the fetched envelope, so every validator reaches the same
determination without adding its own source of disagreement.

**Bonding interaction (connects to the economics section below, #83):** an
`UNDETERMINED` outcome must not charge either bond — the failure to judge is
an evidence-completeness problem upstream, not a finding against the
consumer's claim or the provider's delivery. Both bonds release unspent.
Not yet reflected in #83's issue text; needs updating before that work
starts.

### Evidence access: opt-in, dispute-gated, two separate clocks

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
- Once unlocked, evidence is fetchable — plainly, publicly, no token or
  identity check, because none is enforceable against GenVM's plain outbound
  fetches — so this must be disclosed wherever semantic-claims opt-in is
  described, not framed as "GenLayer-only access." Same disclosure posture as
  the CRE proxy's existing "seen by the enclave and the agent, not by every
  node operator" — restated here because the audience is bigger and the
  identifier is public, so the honest description is: **filing a
  semantic-claims dispute makes that one response publicly readable, by
  design.**

**Two separate clocks, not one.** "Fetchable for the resolution round, then
expires" conflates the deadline to *file* a claim with the runway
*adjudication itself* needs once filed — a claim filed near the filing
deadline must not have its evidence expire mid-execution. Concretely:

- **Filing window** — e.g. 24h from the original call. The proxy retains an
  opted-in call's response internally for this long; if no claim is filed
  before it lapses, the response is deleted, unclaimed and never disclosed.
  This window bounds retention for the (much larger) set of calls nobody
  disputes.
- **Adjudication window** — starts fresh the moment a claim is confirmed
  filed, independent of how much of the filing window remained. The relay
  that already watches GenLayer for verdicts (#84) also watches for
  `submit_claim` and, on seeing one, promotes that `request_id`'s cache entry
  to a new, generous TTL (e.g. 48h) from that moment — padded well past
  GenLayer's own stated appeal ceiling (~3 hours end to end, per GenLayer's
  public figures) to safely cover the leader fetch, every committee member's
  independent re-fetch, retries, and a full appeal escalation. Evidence stays
  immutable and repeatedly GET-able (no consumption, no invalidation) for the
  whole window — a claim opened at hour 23.9 of the filing window still gets
  the full fresh adjudication runway, not six minutes.

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

- [x] `semantic` clause type added to `packages/sla` (schema, evaluator,
      types, test vector) — mixed SLAs parse and CRE's deterministic verdict
      is unaffected; 88 tests pass
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
