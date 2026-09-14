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

### Claim eligibility gate: the part that was missing entirely

Every section above assumed `submit_claim` is called by someone entitled to
dispute that specific `request_id`. It wasn't checking that at all. Since
`request_id` is public (every `VerdictWritten` event), the contract as
written let **anyone** call `submit_claim` against **anyone else's** call,
triggering real GenLayer execution cost with nothing bonded and no
relationship to the original transaction — free spam of the expensive
machinery, and a way to force evidence disclosure (once dispute-gated
serving unlocks it, per above) against a provider or consumer who never
opened anything.

**What a claim must be bound to**, checked on-chain before any GenLayer
execution cost is spent:

- **Registry address** — fixed in contract config, never caller-supplied, so
  a caller cannot point the check at a fake registry that returns whatever
  `Verdict` they want.
- **A verdict that actually exists.** `VerdiktRegistry.getVerdict(requestId)`
  (`contracts/src/VerdiktRegistry.sol:251`) is a plain Solidity mapping read —
  checked directly, `_verdicts[requestId]` for an unset key returns the
  **zero-valued struct**, not a revert: `outcome: PASS(0), payer: 0x0,
  writtenAt: 0`. A bogus or never-written `request_id` silently looks like a
  real `PASS` from a zero address unless the caller explicitly checks
  `writtenAt != 0` (or `payer != address(0)`). This is exactly the gate for
  the "replay-402 / fallback-4xx / missing verdict" cases: a fallback 4xx
  writes no verdict at all (existing invariant), and a replay-402 is a
  transport/payment issue, not a content dispute — both must fail this check
  and be rejected before reaching any judgment logic, undetermined outcome
  included, since there is nothing to judge in the first place.
- **Verified payer.** `verdict.payer`, from the on-chain read above, must
  match the claimant — **not** trusted from a cached response or a payment
  signature alone, since neither actually proves the caller is who they
  claim against *this specific verdict*. Plain-EOA case: `verdict.payer ==
  gl.message.sender_address` works directly, since GenLayer and Arc are both
  standard EVM address spaces and the same key derives the same address on
  either. **Open, not solved here:** Circle Gateway's SCA/backing-EOA case
  (`proxy/.agents/skills/recover-eco-funds/SKILL.md`) — a payer that is a
  Circle Smart Contract Account has a *different* address than its backing
  EOA, and that relationship is resolved through Circle's wallet API
  (`eoaOwnerAddress`), not from on-chain data alone. GenVM has no documented
  way to hold Circle API credentials safely, so this case is unhandled for
  now — plain-EOA payers work, SCA-backed payers currently cannot open a
  claim without some trusted intermediary attesting the relationship, which
  reintroduces exactly the kind of trust assumption this gate exists to
  avoid. Needs its own design pass before the hackathon deadline if SCA
  payers are in scope for the demo.
- **Service/slug correlation.** `verdict.serviceId` should match
  `keccak256(slug)` for the `slug` argument, so a caller cannot claim against
  one service while citing another's SLA.
- **Evidence/SLA version.** `submit_claim`'s criteria-freeze (above) protects
  everything *after* the claim opens, but not the gap between the original
  call (`verdict.writtenAt`) and `submit_claim` being called — a provider
  could still edit their SLA in that window. Fully closing this needs Arc's
  `Verdict` struct (or a companion write) to carry a hash of the SLA content
  that was live at verdict-write time, which it does not today
  (`IVerdiktRegistry.sol:46-56` has no such field) — an Arc-side contract
  change, out of scope for this note, tracked separately.
- **Bond.** `submit_claim` should verify a consumer bond was actually posted
  for this `request_id` (economics section below) before proceeding — not
  trust the caller, for the same reason as the payer check.
- **Deadline.** Reject if called after the filing window (two-clocks design,
  above) has lapsed since `verdict.writtenAt`.
- **Duplicate protection, corrected.** The claim key must be `(request_id,
  clause_id)`, not `request_id` alone — a single verdict can have multiple
  semantic clauses, each independently disputable. Keying on `request_id`
  alone (the original scaffold) would silently allow only one semantic claim
  per call, ever, even when an SLA declares several semantic clauses.

**Read mechanics, confirmed available:** `genlayer-studio-bridge-boilerplate`
uses `gl.evm.MethodEncoder(name, abi, return_type)` from within a GenLayer
contract to build EVM calldata (`intelligent-contracts/BridgeSender.py`) —
the building block for encoding `getVerdict(bytes32)` and reading Arc via a
raw JSON-RPC `eth_call` through `gl.nondet.web.post`, mirroring the ENS-read
pattern already used for SLA criteria. The decode side needs a bit more
verification before implementation — noted as the concrete next step, not
assumed correct here.

**Status:** specified, not yet implemented — the composite `(request_id,
clause_id)` claim key is a safe, low-risk fix and should land first; the
on-chain `getVerdict` gate and the deadline/bond checks are the actual
security boundary and need the read-mechanics verification above before
landing. Tracked as its own issue given the scope and severity.

### A second, independent judgment — not an appeal of CRE's verdict

Language earlier in this document and in issue #83 ("the verdict upholds the
original outcome") wrongly implied GenLayer's semantic judgment reverses or
appeals CRE's PASS/FAIL/DOWN. It doesn't, and can't: a response can
legitimately pass every deterministic clause and still breach a semantic
one, or the reverse — schema/latency/price and "does this content actually
satisfy what was promised" are orthogonal questions. GenLayer adds a second,
independent judgment dimension on clauses CRE never touches at all, on the
same call. Correcting the framing everywhere it appears.

That correction has real consequences, checked against the actual contract
rather than assumed:

**A GenLayer semantic verdict cannot reuse `VerdictWritten`.**
`VerdiktRegistry.sol`'s `_recordVerdict` rejects outright: `if
(_verdicts[requestId].writtenAt != 0) { emit VerdictRejected(...,
DUPLICATE_REQUEST); return; }`. CRE already wrote a verdict for this
`request_id` — attempting to relay GenLayer's outcome through the same path
is silently rejected as a duplicate, not merged, not overwritten. The relay
(#84) needs a genuinely new event and a new record, e.g. `_semanticSettlements[requestId][clauseId]`
and `SemanticSettlementWritten(...)`, keyed the same composite way the
GenLayer contract already keys claims — not a second write to `_verdicts`.

**Refund must account for what CRE already credited, or the per-call cap
breaks.** `_recordVerdict` already caps CRE's own refund at
`min(FIXED_REFUND, paidNative, service.deposit)`
(`VerdiktRegistry.sol:194-200`) — the invariant this protects is explicit
elsewhere in the repo: "a refund larger than the payment makes
induced-failure griefing profitable with no arbitration to fall back on." A
call can get a CRE `FAIL` (refund already credited) *and* a semantic
`BREACH` (a second, independent judgment) — settling the semantic refund as
a fresh, uncapped allowance would let one paid call collect two refunds and
blow through that cap. The settlement path must read the existing
`getVerdict(requestId).refundCredited` (the same on-chain read the
eligibility gate, #90, already needs) and cap the *additional* semantic
credit at `FIXED_REFUND - existingCredited`, clamped to zero — never assume
the semantic refund starts from a clean allowance.

**Dashboard must show both, not collapse them.** A call's full record is now
one CRE verdict plus zero or more semantic settlements (one per disputed
clause), each independently outcome-bearing. Folding them into a single
displayed status would misrepresent exactly the case that motivated this
whole feature — CRE PASS, semantic BREACH.

**Reputation: a separate score, not folded into `conformance`.** The
existing `conformance`/`availability` ENS text records are computed purely
from `VerdictWritten` (Specification.md §1) and are already referenced in
the frozen ETHOnline submission's evidence — silently changing what they
measure would misrepresent those already-published numbers. Recommend a
third score, e.g. `semanticConformance`, written by its own signer
(mirroring the existing per-key EAC pattern `sla`/`conformance`/
`availability` already uses) from `SemanticSettlementWritten` events, same
1000-when-empty convention. Leaving it unaggregated anywhere means semantic
failures never affect a provider's advertised standing at all — defeating
the point of judging them.

### Withdrawal cooldown: the pre-filing escape route

Every mechanism above assumes the provider's deposit is still there when a
semantic settlement needs it. Nothing currently guarantees that. Checked
`VerdiktRegistry.sol`'s `deregister()` directly: while `ACTIVE`, a provider
can deregister and receive their **entire remaining deposit, immediately,
unconditionally** — `returned = service.deposit; service.deposit = 0; ...
_send(msg.sender, returned)`, no cooldown, no pending-claim check.

CRE's own refund never had this problem because it's synchronous — the
verdict is written, and any refund credited, inside the same call that
evaluates the response, with no window for the provider to react in between.
Semantic claims are the opposite by design: up to a 24-hour filing window
plus adjudication time. A provider who suspects a semantic dispute is coming
(or simply exits routinely) can deregister and withdraw before a consumer
ever files — the claim can still resolve `BREACH`, but there is nothing left
to draw a refund or the GenLayer-cost reimbursement from. This is a
consequence of adding *any* delayed dispute mechanism on top of a
deposit-return path that was built assuming only instant, synchronous
settlement — not a flaw specific to this design's other pieces.

**Fix, specified, not yet implemented:**

- **Deregistration cooldown.** `deregister()` should stop returning funds
  immediately. Move the service to a new `DEREGISTERING` status and start a
  timer; the deposit becomes withdrawable only after a cooldown that safely
  exceeds the filing window plus adjudication time (e.g. 72h, well past the
  24h + ~3h GenLayer appeal figures already in play elsewhere in this doc —
  pick with margin, not exactly at the boundary). A pending semantic claim
  can still settle against the locked-but-not-yet-withdrawn deposit during
  that window.
- **Concurrent liabilities, re-checked at settlement, not just at
  claim-open.** The refund-cap fix above (read `refundCredited`, cap the
  additional semantic credit) is necessary but not sufficient on its own —
  the deposit can shrink further between claim-submission and actual
  settlement if other verdicts or other semantic settlements draw on the
  same pool concurrently. Settlement must re-clamp against the *current*
  `service.deposit` at the moment funds are actually credited, the same way
  `_recordVerdict` already does for CRE (`credited = min(FIXED_REFUND,
  paidNative, service.deposit)`) — not trust a balance checked earlier.
- **Insufficient-funds behavior mirrors the existing pattern, not a new
  failure mode.** If the deposit is fully drawn down by settlement time, the
  semantic credit clamps to whatever remains (possibly zero) — it does not
  revert, and the judgment (`MET`/`BREACH`/`UNDETERMINED`) is still recorded
  regardless of whether funds were available to back it. Same separation
  CRE already has between "the verdict" and "the payout."

### Economics: two separate accounting lines, not one "refund + cost" blob

"Refund plus GenLayer execution cost," used loosely up to this point, was
never actually specified — who fronts execution costs, who gets reimbursed,
how a GEN-denominated cost is priced in USDC, what caps apply, and what
happens to a claimant's own bond were all left open. Left underspecified,
the execution-cost side in particular is a real drain vector: an unbounded
or self-reported cost claim against a provider's deposit is the same shape
of attack the refund cap already exists to prevent.

**Two lines, two independent caps, never merged:**

- **Refund** — the existing shape, extended: `min(FIXED_REFUND, paidAmount,
  remaining deposit)`, minus what CRE already credited (above). Tied to the
  size of the original x402 payment, exactly like today.
- **GenLayer execution-cost reimbursement** — a **fixed USDC bounty**
  (e.g. `GENLAYER_COST_BOUNTY`, a protocol constant), *not* metered against
  actual GEN gas spent. Metering would need a GEN/USDC price oracle and would
  let whoever reports the cost claim an arbitrary amount — a fixed bounty
  sidesteps both. Same cap regardless of whether the claim escalated to
  GenLayer's own internal appeal jury (a bigger, more expensive round) — the
  bounty does not grow with actual cost, it simply covers less of it.

**Who fronts vs. who's reimbursed.** Someone needs GEN in a GenLayer wallet
*before* any Arc-side settlement can happen — the two chains settle on
different timelines, and Arc reimbursement is necessarily after the fact.
Realistically the relay (#84) fronts this, not the consumer directly
(requiring end users to hold GEN defeats the point of a USDC-native
marketplace). The relay is reimbursed the fixed bounty from whichever side's
funds are liable once Arc-side settlement completes.

**Bond disposition, fully specified:**

- **Consumer wins (`BREACH`):** consumer's bond returned in full, untouched
  — they were right. Provider's deposit pays the refund plus the fixed
  bounty (reimbursing the relay).
- **Consumer loses (`MET`):** consumer's bond pays the fixed bounty
  (reimbursing the relay); any **surplus** above that fixed amount is
  returned to the consumer, never kept as a default. Deters frivolous claims
  without turning a lost claim into an uncapped penalty.
- **`UNDETERMINED`:** neither party's bond is charged — an evidence-envelope
  failure is upstream of both parties. The relay still fronted real gas for
  the attempt; for now that's an absorbed operating cost, not passed to
  either party. Flagging as a business-model decision to revisit, not
  settling it unilaterally here.
- **`CANCELLED`** (new — see below): consumer's bond returned in full. A
  resolution that never happens is an infrastructure failure, not a
  judgment against the consumer.

**Timeout / cancellation path for infrastructure failure.** Nothing
previously defined what happens if `resolve_claim` simply never succeeds —
relay down, evidence expired before adjudication finished, ENS unreachable,
GenLayer consensus itself failing to reach agreement. Without an explicit
path, the consumer's bond would sit locked indefinitely with no judgment and
no return — not forfeited, but not returned either, worse than either
resolution. Fixed with a fourth outcome, `CANCELLED`, and a permissionless
`cancel_claim(request_id, clause_id)`: anyone may call it once a resolution
timeout has elapsed since `submit_claim` (sized past the filing +
adjudication window with margin, mirroring the deregistration cooldown
above), marking the claim `CANCELLED` and returning the consumer's bond in
full. Mirrors GenLayer's own permissionless idleness-call pattern for
stalled validator rounds, rather than inventing a new access-control shape.
Implemented and reasoned through the same way as the rest of this contract
(no PyPI/GitHub access in this sandbox to execute it) — `genlayer/contracts/sla_claim_judge.py`.

Settlement itself is applied back to Arc by the relay, reading the GenLayer
verdict and calling the new `SemanticSettlementWritten` path (not
`VerdictWritten`) on the escrow contract — not yet built, tracked in the
GitHub issue, and now specified precisely enough to build correctly rather
than reopening the refund-cap invariant by accident.

## What's built vs. not (as of Sep 14, 2026)

- [x] `semantic` clause type added to `packages/sla` (schema, evaluator,
      types, test vector) — mixed SLAs parse and CRE's deterministic verdict
      is unaffected; 88 tests pass
- [x] Contract scaffold, generic claim-type engine (`genlayer/contracts/sla_claim_judge.py`)
- [x] Evidence envelope, frozen criteria, `UNDETERMINED` outcome, image
      support — reasoned through against confirmed API patterns, not yet
      test-executed (no PyPI/GitHub access in this sandbox)
- [x] Composite `(request_id, clause_id)` claim key — a verdict can carry
      several disputable semantic clauses
- [x] `CANCELLED` outcome + permissionless `cancel_claim` timeout path —
      configurable `resolution_timeout_hours`, so an unresolved claim
      doesn't lock the claimant's bond forever
- [x] Direct-mode tests with mocked web/LLM (`genlayer/tests/direct/`)
- [x] Local reference clones: `genlayer-boilerplate`,
      `genlayer-studio-bridge-boilerplate`
- [ ] **Claim eligibility gate** — on-chain `getVerdict` check (registry
      address, real verdict exists, verified payer, service/slug match,
      bond posted, filing deadline), currently entirely missing; anyone can
      call `submit_claim` against anyone's public `request_id` today
- [ ] Provider opt-in flag for semantic claims (ENS text record)
- [ ] Proxy response cache for opted-in services, `GET /internal/sla/<slug>`,
      and the dispute-gated `GET /internal/evidence/<request_id>` (returns
      nothing until `submit_claim` has opened a claim for that id)
- [ ] Consumer bonding + relay settlement back to Arc (including
      `UNDETERMINED` releasing both bonds unspent)
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
