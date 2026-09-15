# Roadmap — GenLayer non-deterministic claim judging

**Status: active build, second hackathon track.** Unlike `erc-8004.md`, this is
not post-hackathon research — it is being built now, on the `feat/genlayer`
branch, for GenLayer's **Agent Tank** hackathon (portal:
https://portal.genlayer.foundation/agent-tank/, track: **Agentic Commerce
Infrastructure**, build window Sep 3–17, submissions close **Sep 17 · 15:30
UTC**, winners announced Sep 25, prize: 5% of all GenLayer Points). `main`
stays frozen for the ETHOnline 2026 submission; nothing here touches it.

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

## Why Verdikt fits this track

The "Agentic Commerce Infrastructure" track wants "SLA and uptime
enforcement — API escrow that releases against signed logs or decentralized
monitoring." Verdikt already runs exactly this, live, with Chainlink CRE
doing deterministic per-call SLA verification and an Arc registry/escrow
settling refunds. CRE can only evaluate schema-checkable, deterministic
claims (status codes, latency, price); it cannot judge whether a
deliverable's *content* satisfies what was promised — LLM output quality,
file/media evidence, anything requiring judgment rather than a schema match.
GenLayer covers exactly that gap, as a second, independent claim type on the
same escrow — not a replacement for CRE.

**CRE stays untouched on every live call, by design, for three reasons:**

1. **Confidentiality.** CRE's TEE guarantee is that the response body is seen
   by one attested enclave plus the paying agent, not by an open validator
   set. GenLayer's randomly-selected, unattested committee is a different,
   wider audience — appropriate for evidence a claimant has voluntarily
   chosen to disclose, not for every live call by default.
2. **Execution model.** GenLayer's consensus has every committee member
   independently re-fetch the same data to compare against the leader —
   suited to stable, re-fetchable evidence, not a one-time, non-idempotent
   HTTP exchange between an agent and a provider. CRE replays the actual
   response it already has, synchronously, in the request path.
3. **Cost.** A real HTTP call inside a GenLayer nondet block fires once per
   validator (leader + full committee), not once — appropriate for the
   occasional disputed call, not the default path for every paid request.

GenLayer only handles claims filed after the fact, where the claimant is
voluntarily engaging a slower, disclosed arbitration path.

Closest prior art: **Recourse** (github.com/A-Raphie/recourse) has the
jury/verdict shape but its x402 integration is disabled/symbolic; **ASSAY**
(github.com/Franlinozz/ASSAY) has real x402 but only deterministic checks;
**Uptime** (github.com/genlayer-foundation/uptime, the track's own reference
project) is deterministic-only by design and has no payment layer. Verdikt's
edge: dual claim-type routing (CRE + GenLayer) on an already-live escrow,
rather than a greenfield demo.

## Architecture

### SLA schema compatibility: a new clause type

`packages/sla/schema.json` validates each clause against `oneOf` a fixed set
of known types, `additionalProperties: false`, and a document with an
unrecognized clause type fails validation entirely — `evaluate()` falls back
to status-only, losing every deterministic clause, not just the new one. A
semantic clause type therefore has to be a first-class schema branch, not an
afterthought.

**Implemented:** a fourth `oneOf` branch, `"type": "semantic"`, with its own
field, `criteria` (string, the binding judgment text) — kept separate from
the existing `description` field, which stays decorative on every clause
type. `clauses.js`'s `evaluateClause` has a `case 'semantic'` that always
returns `pass: true`: CRE accepts the clause as schema-valid and lists it in
the per-call result, but never enforces it, so a mixed SLA's deterministic
clauses still get a real PASS/FAIL/DOWN verdict independent of the semantic
one. GenLayer's `resolve_claim` filters `sla.clauses` for `type ===
'semantic'` and judges each one's `criteria` on dispute — the two engines
partition the same document by clause type and never touch each other's
clauses. Covered by `packages/sla`'s test suite (88 tests, including a mixed
schema+semantic vector).

**Provider opt-in is separate from schema validity.** A provider can publish
a syntactically valid `semantic` clause without enabling evidence caching
(below) — schema validation stays pure and dependency-free, so it cannot
check an opt-in flag. An SLA published without the opt-in flag is
well-formed but unenforceable: no evidence will ever be cached to adjudicate
it. That's a dashboard/SLA-editor warning at authoring time, not a
schema-level constraint.

### Claim contract (`genlayer/contracts/sla_claim_judge.py`)

A GenLayer Intelligent Contract, `SlaClaimJudge`, with direct-mode tests
against mocked web/LLM calls (`genlayer/tests/direct/`, see
`genlayer/README.md`). Two writes:

- `submit_claim(request_id, slug, clause_id)` — opens a claim for one
  specific semantic clause and **freezes its `criteria` text** from ENS at
  this moment, via an exact-match nondet fetch. Not re-fetched later: a
  provider editing its SLA mid-dispute must not be able to change what is
  being judged, mirroring the guard `packages/sdk/registry.js`'s
  `failedClause` hash already provides on the deterministic side.
- `resolve_claim(request_id, clause_id)` — fetches the evidence envelope
  (below) and either returns `UNDETERMINED` with a reason (envelope missing,
  unsupported content type, transport failure) or builds a judgment prompt
  from the frozen criteria plus the envelope's request/response fields,
  routing to `exec_prompt(images=[...])` for image evidence or plain text
  otherwise. Reaches a verdict via a custom `run_nondet_unsafe`
  leader/validator pair comparing only the decision field (`outcome:
  "MET"|"BREACH"|"UNDETERMINED"`), never free-text reasoning — GenLayer's
  recommended pattern for settlement-type decisions.
- `cancel_claim(request_id, clause_id)` — permissionless, timeout-gated;
  closes a stalled claim and returns the consumer's bond.
- `get_claim(request_id, clause_id)` — view.

Claims are keyed by `(request_id, clause_id)`, not `request_id` alone, since
a single verdict can carry several independently disputable semantic
clauses.

### Evidence envelope: what gets judged, and what doesn't

A response body alone isn't sufficient evidence — judging whether a
deliverable satisfies a clause needs the request that produced it too, and a
truncated or unsupported body must not be silently judged as complete.

`proxy/src/router.js` passes `bodyHex: bodyToHex(body)` into
`workflow.verify({...})`, and `cre/workflows/verify/workflow.ts` carries
`bodyHex: string | null` through to the provider. The evidence envelope's
`request.body` is populated from this field for non-GET/HEAD requests.
`cre/workflows/verify/workflow.ts:162` truncates the relayed body to 20,000
chars before it reaches the proxy callback (a direct enclave→proxy POST, not
subject to DON consensus size limits) — the evidence cache must account for
this truncation rather than assume it always has the full body; tracked
separately (#88).

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
`exec_prompt(images=[...])`). Anything else — missing fields,
`response.status: null` (a transport failure, not a semantic dispute), an
unrecognized content type, a truncated body — makes the envelope
**unsupported**, and `resolve_claim` returns `UNDETERMINED` with a stated
reason rather than defaulting to `MET` or `BREACH` against either party.
`_envelope_unsupported_reason` is a pure function of the fetched envelope, so
every validator reaches the same determination independently.

**Bonding interaction:** an `UNDETERMINED` outcome charges neither bond — an
evidence-completeness failure is upstream of both parties' claims. Both
bonds release unspent.

### Evidence access: opt-in, dispute-gated, two separate clocks

Evidence is never servable by default. Two gates, both required:

- **Opt-in at the provider level.** A service must explicitly declare
  semantic-claims support (an ENS text record alongside `sla`, same per-key
  ACL pattern) before its responses are cached at all. Providers who never
  opt in carry zero exposure from this feature.
- **Gated by dispute, not by cache.** The proxy holds each opted-in call's
  response internally for a bounded window, but `GET
  /internal/evidence/<request_id>` returns nothing until `submit_claim` has
  actually been called for that `request_id` on GenLayer. Opening a claim is
  the authenticated, on-chain, attributable act that unlocks disclosure —
  not knowledge of a public identifier (`request_id` is public in every
  `VerdictWritten` event).
- Once unlocked, evidence is fetchable — plainly, publicly, no token or
  identity check, since none is enforceable against GenVM's plain outbound
  fetches. This must be disclosed wherever semantic-claims opt-in is
  described: **filing a semantic-claims dispute makes that one response
  publicly readable, by design.**

**Two separate clocks.** The deadline to *file* a claim and the runway
*adjudication* needs once filed are different windows — a claim filed near
the filing deadline must still get a full adjudication runway:

- **Filing window** — 24h from the original call. The proxy retains an
  opted-in call's response internally for this long; if no claim is filed
  before it lapses, the response is deleted, unclaimed and never disclosed.
- **Adjudication window** — starts fresh the moment a claim is confirmed
  filed. On seeing `submit_claim`, the cache entry is promoted to a new,
  generous TTL (48h) from that moment, padded past GenLayer's own stated
  appeal ceiling (~3 hours end to end) to cover the leader fetch, every
  committee member's independent re-fetch, retries, and a full appeal
  escalation. Evidence stays immutable and repeatedly GET-able (no
  consumption, no invalidation) for the whole window.

### Settlement currency: a custom token, native to GenLayer

Settlement for semantic claims uses a dedicated ERC-20-equivalent token,
deployed on GenLayer itself, with a permissionless `mint()` (a
hackathon-appropriate faucet). It is not pegged to USDC or any other asset —
GEN, GenLayer's native gas token, was considered and rejected for the same
reason: neither is dollar-denominated, so a custom token with USDC's
6-decimal convention gives the demo a legible number to compare against the
original payment without implying a real peg.

This removes any cross-chain settlement requirement: GenLayer never writes
back to Arc. It still *reads* `VerdiktRegistry.getVerdict()` — a plain nondet
`eth_call`, no bridge needed for reads — to confirm a real verdict exists and
who paid. CRE and Arc are otherwise untouched: the reasons CRE stays
untouched (confidentiality, execution model, cost — above) are about the
*live-call* verification path and are independent of currency; only
semantic-claims settlement, which already operates on cached, disclosed
evidence, moves onto GenLayer.

**Finality.** `claim.resolved` must reflect a *finalized* result, not merely
an accepted one — GenLayer's own docs note an Accepted receipt can still be
recomputed after appeal. GenLayer's internal messaging primitive handles
this natively: IC-to-IC calls take an `on=` parameter, and `on='finalized'`
is the documented default for exactly this reason (`on='accepted'` messages
"may be emitted multiple times across appeal rounds" and can't be taken
back). `resolve_claim` calls the settlement token's `transfer` via
`.emit(on='finalized')`, so the platform itself defers the balance change
until finality.

**Arc dependency is read-only.** GenLayer reads `getVerdict()` for
eligibility (below); nothing writes back, so there is no signing key or
relay acting as a settlement authority over anyone's funds.

### Claim eligibility gate

`submit_claim` must verify the caller is entitled to dispute the specific
`request_id` before any GenLayer execution cost is spent — `request_id` is
public in every `VerdictWritten` event, so without this check, anyone could
open a claim against anyone else's call. Checked on-chain:

- **Registry address** — fixed in contract config, never caller-supplied.
- **A verdict that actually exists.** `VerdiktRegistry.getVerdict(requestId)`
  is a plain mapping read; an unset key returns a **zero-valued struct**, not
  a revert (`outcome: PASS(0), payer: 0x0, writtenAt: 0`). The gate must
  check `writtenAt != 0` explicitly — this also correctly rejects the
  "no verdict was ever written" cases (a fallback 4xx, or a replay-402),
  since there's nothing to judge in either case.
- **Verified payer.** `verdict.payer` must match the claimant. For a
  plain-EOA payer, `verdict.payer == gl.message.sender_address` works
  directly — GenLayer and Arc are both standard EVM address spaces. **Open:**
  a payer that is a Circle Smart Contract Account has a different address
  than its backing EOA, and that relationship is only resolvable through
  Circle's wallet API, not on-chain data alone; SCA-backed payers can't
  currently open a claim without a trusted intermediary. Needs its own design
  pass if SCA payers are in scope for the demo.
- **Service/slug correlation.** `verdict.serviceId` must match
  `keccak256(slug)` for the `slug` argument.
- **Bond.** `submit_claim` verifies a consumer bond was posted for this
  `request_id` — a same-chain balance/escrow read against the settlement
  token.
- **Deadline.** Reject if called after the filing window has lapsed since
  `verdict.writtenAt`.

`gl.evm.MethodEncoder(name, abi, return_type)` builds the calldata to read
Arc via `eth_call` through `gl.nondet.web.post`, mirroring the ENS-read
pattern already used for SLA criteria.

**Status:** specified, not yet implemented. Tracked as its own issue.

**Known gap:** `submit_claim`'s criteria-freeze protects the claim once
opened, but not the gap between the original call (`verdict.writtenAt`) and
`submit_claim` being called — a provider could still edit its SLA in that
window. Closing this needs Arc's `Verdict` struct (or a companion write) to
carry a hash of the SLA content live at verdict-write time, which it doesn't
today — an Arc-side contract change, out of scope here, tracked separately.

### A second, independent judgment

GenLayer's semantic judgment does not reverse or appeal CRE's PASS/FAIL/DOWN
verdict. A response can legitimately pass every deterministic clause and
still breach a semantic one, or the reverse — schema/latency/price and "does
this content satisfy what was promised" are orthogonal questions. GenLayer
adds a second, independent judgment dimension on clauses CRE never touches,
on the same call.

Consequences:

- **No `VerdictWritten` collision.** Semantic settlement never touches
  `_verdicts` or Arc at all — it lives entirely in GenLayer's settlement
  token / claim contract state, so it can't collide with
  `_recordVerdict`'s duplicate-request rejection.
- **No shared refund cap.** CRE's refund is USDC from Arc's
  `service.deposit`; semantic settlement is the custom token from a
  separate GenLayer-native pool. A call getting both a CRE `FAIL` and a
  semantic `BREACH` draws from two independent pools in two independent
  currencies — nothing to double-spend against.
- **Dashboard shows both.** A call's full record is one CRE verdict (Arc,
  USDC) plus zero or more semantic settlements (GenLayer, custom token) —
  different chains and currencies, shown separately, not collapsed into one
  status.
- **Reputation is a separate score**, sourced from GenLayer, not
  `VerdictWritten`. The existing `conformance`/`availability` ENS records
  stay computed purely from Arc's events, unaffected. A third score (e.g.
  `semanticConformance`, same 1000-when-empty convention, own ENS signer
  role) would be aggregated by reading GenLayer's own settlement
  events/state — a different aggregation mechanism from the existing hourly
  workflow, not an extension of it. Not yet built.

### Withdrawal cooldown

Whatever holds a provider's semantic-claims deposit must not allow instant
withdrawal, or a provider can post the deposit, take calls, and withdraw
before a consumer ever files — the same escape route `VerdiktRegistry`'s
`deregister()` has today on Arc (a provider can pull its entire deposit
immediately while `ACTIVE`), now against the GenLayer-native settlement
token's deposits instead.

**Specified, not yet implemented:**
- Deregistration/withdrawal moves to a pending status with a cooldown
  safely exceeding the filing + adjudication window (72h, past the 24h +
  ~3h GenLayer appeal figures above).
- Settlement re-clamps against the deposit's *current* balance at credit
  time, handling concurrent liabilities when multiple claims draw on the
  same provider's pool.
- Insufficient funds clamp to whatever remains rather than reverting — the
  judgment (`MET`/`BREACH`/`UNDETERMINED`/`CANCELLED`) is always recorded
  regardless of whether funds backed it, the same split CRE already has
  between verdict and payout.

### Deployment: entirely new contracts on GenLayer, Arc untouched

`VerdiktRegistry` stays exactly as it is on Arc Testnet
(`0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af`) — no migration for its
existing bonds, refunds, or registrations, because nothing new is deployed
there. The settlement token and bonding/escrow logic deploy fresh on
GenLayer, which has no live state to protect. GenLayer's settlement pool and
Arc's `service.deposit` are different chains, so there's no shared balance a
claim could drain.

The only Arc dependency is a read (`getVerdict()`, eligibility gate, above)
— no write, no deployment, no migration.

### Claimant interface

A claimant-facing CLI (mirroring `scripts/pay-x402.mjs`'s existing pattern —
an interactive script, not a UI) for minting test settlement tokens, opening
a claim, posting a bond, checking status, and withdrawing once settled — all
against GenLayer, no Arc-side step for this path. Tracked as its own issue
(#94).

**Acceptance criteria for the demo:**
- A claim that resolves `BREACH` (successful claimant) *and* one that
  resolves `MET` (rejected claimant) — not just one happy path.
- Actual settlement-token balance read-back on GenLayer before and after
  settlement, not just "the transaction didn't revert."
- A demonstrated `CANCELLED` / infrastructure-failure recovery — the
  timeout path actually exercised, not just present in the contract.

### Economics: two accounting lines, both in the custom token

**Two lines, two independent caps, never merged:**

- **Compensation** — separate from CRE's refund, which stays a USDC/Arc-only
  concern. Sized to numerically match the original `paidAmount` (read from
  Arc's `getVerdict()`) in the custom token's own units — not a currency
  conversion, since the token isn't pegged to anything, just a legible
  number to compare against the original payment. Capped at
  `min(compensation, remaining GenLayer-native deposit)`.
- **GenLayer execution-cost bounty** — a **fixed** amount in the same token
  (a protocol constant), not metered against actual gas spent, avoiding both
  a price-tracking dependency and an unbounded self-reported cost claim.

**Gas.** Settlement happens natively inside `resolve_claim`
(`.emit(on='finalized')`), so whoever calls `submit_claim`/`resolve_claim` —
the claimant, through the CLI — pays their own GEN gas directly, like any
transaction. The execution-cost bounty reimburses that gas from the losing
side's funds: the provider's deposit if the claimant wins, the claimant's
own bond if they lose.

**Bond disposition:**

- **Consumer wins (`BREACH`):** consumer's bond returned in full. Provider's
  GenLayer-native deposit pays the compensation plus the execution-cost
  bounty.
- **Consumer loses (`MET`):** consumer's bond pays the execution-cost
  bounty; any surplus above that fixed amount is returned to the consumer,
  never kept as a default.
- **`UNDETERMINED`:** neither bond is charged — an evidence-envelope failure
  is upstream of both parties. The claimant's spent gas is an absorbed cost
  of the attempt (flagged as a business-model decision to revisit, not
  settled here).
- **`CANCELLED`:** consumer's bond returned in full — an unresolved claim is
  an infrastructure failure, not a judgment against the consumer.

`cancel_claim` (implemented) lets anyone close a claim permissionlessly once
a resolution timeout elapses since `submit_claim`, returning the consumer's
bond in full — mirroring GenLayer's own permissionless idleness-call pattern
for stalled validator rounds.

**Not yet built:** the settlement token contract, bonding logic in
`submit_claim`, and the finalized-gated payout in `resolve_claim` (currently
records an outcome but doesn't move funds). Tracked in GitHub issues.

## What's built vs. not

- [x] `semantic` clause type in `packages/sla` (schema, evaluator, types,
      test vector) — mixed SLAs parse and CRE's deterministic verdict is
      unaffected; 88 tests pass
- [x] Contract scaffold, generic claim-type engine
      (`genlayer/contracts/sla_claim_judge.py`)
- [x] Evidence envelope, frozen criteria, `UNDETERMINED` outcome, image
      support
- [x] Composite `(request_id, clause_id)` claim key
- [x] `CANCELLED` outcome + permissionless `cancel_claim` timeout path
- [x] Judge acceptance criteria: bounded structured outcome, independent
      validation, prompt-injection delimiting for untrusted content, explicit
      `INCONCLUSIVE` path distinct from envelope-support failures
- [x] Direct-mode tests with mocked web/LLM (`genlayer/tests/direct/`)
- [ ] Settlement token contract (permissionless `mint()`, balances), bonding
      wired into `submit_claim`, `resolve_claim` paying out via
      `.emit(on='finalized').transfer(...)` instead of just recording an
      outcome
- [ ] Claim eligibility gate — on-chain `getVerdict` read (registry address,
      real verdict exists, verified payer, service/slug match, filing
      deadline, bond-posted check); currently missing, so anyone can call
      `submit_claim` against anyone's public `request_id`
- [ ] Provider opt-in flag for semantic claims (ENS text record)
- [ ] Proxy response cache for opted-in services, `GET /internal/sla/<slug>`,
      and the dispute-gated `GET /internal/evidence/<request_id>`
- [ ] Consumer bonding + native settlement
- [ ] Claimant CLI (#94): mint test tokens, open a claim, post a bond, check
      status, withdraw
- [ ] Deploy to Bradbury testnet
- [ ] Submission assets (live demo URL, logo, one-liner, description,
      how-to steps, submit via portal)

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
- Competitor projects: Uptime (https://uptime-rouge.vercel.app/,
  https://github.com/genlayer-foundation/uptime), Internet Court
  (https://internetcourt.org/, an agent-skill router whose own adjudication
  layer routes to GenLayer Intelligent Contracts), Apolo
  (https://apolo-protocol.xyz/), MergeProof (https://mergeproof.com/),
  Recourse (https://github.com/A-Raphie/recourse), ASSAY
  (https://github.com/Franlinozz/ASSAY)
