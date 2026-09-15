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

- **Correction:** an earlier version of this document said the CRE trigger
  never receives a request body at all. That was true when written, and is
  no longer true — `main` shipped "Replay the agent's request body to the
  provider" (#45, commit `57a3eb9`) after this design was drafted but before
  it was re-checked. This local checkout had gone stale (~2.5 days, 40+
  commits behind `origin/main`) without being re-fetched — caught only when
  reconciling `feat/genlayer` with the actual remote branch, not by design.
  Current state, re-verified directly against `origin/main`:
  `proxy/src/router.js`'s `verified()` now passes `bodyHex: bodyToHex(body)`
  into `workflow.verify({...})`, and `cre/workflows/verify/workflow.ts`'s
  `VerifyRequest` carries `bodyHex: string | null`, replayed to the provider.
  The envelope's `request.body` should be populated from this, not left
  `null` — Day 2 work, not yet done in the scaffold.
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

`request.body` is `null` for GET/HEAD; for other methods it should now be
populated from `bodyHex` (`workflow.ts`'s `VerifyRequest.bodyHex`), not left
unconditionally `null` — see the correction above.

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

### Settlement currency: a custom token, native to GenLayer, no bridge at all

**Superseded (Sep 15): no relay, no bridge, no Arc write-back.** Everything
below this point through "Deployment" replaces several rounds of relay/
bridge/trust-model design that turned out to be solving a problem that
didn't need to exist. The chain of reasoning, kept because the dead ends are
informative:

1. Original plan: settle refunds in USDC on Arc, requiring GenLayer to write
   back cross-chain. No native bridge exists (GenLayer's own currency is
   `GEN`, no USDC on GenLayer chain), so this meant either the official
   LayerZero bridge (`genlayer-studio-bridge-boilerplate`, cloned at
   `hackathon/genlayer-studio-bridge-boilerplate/`) or a custom relay.
   LayerZero V2 only has **Arc Mainnet** deployed (chain ID 5042, checked
   across V1/V2 docs and several per-chain listings, not a single guessed
   URL — still absence of evidence, not a documented negative, but
   well-supported), ruling out the official bridge against Arc Testnet.
2. A custom relay was specified in detail — finality polling, a trust model
   naming the relay's signing key as a full settlement authority, replay
   protection, durable progress, retries, read-back. All of that
   engineering existed to solve one problem: getting a USDC-denominated
   result from GenLayer onto Arc.
3. **The premise was wrong.** Nothing requires the semantic-claims refund to
   be denominated in the *same* currency as the original x402 payment. A
   dedicated token, deployed on GenLayer itself with a permissionless
   `mint()` (a hackathon-appropriate stand-in for a faucet — GEN was
   considered first, but GEN is a plain utility/gas token with no
   dollar-parity, and using it directly would leave the same numerical
   mismatch a custom token avoids by matching USDC's 6-decimal convention),
   removes the cross-chain requirement entirely. GenLayer still *reads* Arc
   (`getVerdict()`, a plain nondet fetch, no bridge needed for reads) to
   confirm a real verdict exists and who paid — settlement itself never
   leaves GenLayer.

**Why this doesn't reopen "just move everything to GenLayer."** That was
considered and rejected earlier for two reasons that have nothing to do with
currency and still fully apply: GenLayer has no TEE, so moving the *live,
per-call* verification there would expose every paid response to every
validator, not just disputed ones; and GenLayer's consensus requires every
validator to independently re-fetch and agree on the same result, which
fits judging *cached* evidence (a stable blob, fetched the same way every
time) but not a one-time, already-consumed HTTP exchange. CRE stays exactly
where it is, judging exactly what it judges today. Only the semantic-claims
settlement — already reading cached evidence, always compatible with
GenLayer's consensus model — moves fully onto GenLayer.

**Finality is still required, solved natively instead of via a relay.**
The finality lesson from the (now superseded) relay design is real and
still applies: `claim.resolved = True` flips at Accepted, not Finalized, and
GenLayer's own docs are explicit that "an Accepted receipt... can require it
and later non-finalized transactions... to be recomputed." Settling funds
against a merely-Accepted result is settling against a result that can
still change. GenLayer's own messaging primitive solves this directly,
without any external polling: internal IC-to-IC calls take an `on=`
parameter, and `on='finalized'` — "the message executes after the parent
transaction is fully finalized (appeal window has closed)" — is **the
documented default**, specifically because `on='accepted'` messages "may be
emitted multiple times across appeal rounds" and "cannot be taken back" if
a later appeal changes the outcome. `resolve_claim` calls the settlement
token's `transfer` via `.emit(on='finalized')` — the platform itself defers
the actual balance change until finality, the same guarantee the relay
design was manually reconstructing.

**Read-only Arc dependency, no trust model needed for settlement.** GenLayer
still reads `VerdiktRegistry.getVerdict()` for eligibility (verified payer,
a real verdict exists, service/slug match — see below), but a read has no
settlement-authority problem: nothing writes back, so there is no signing
key that becomes a de facto authority over anyone's funds, and no replay/
retry/read-back engineering for a write that no longer happens.

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
  for this `request_id` (economics section below) before proceeding. Simpler
  than originally scoped: the bond now lives in the same GenLayer contract
  ecosystem as the check itself (custom settlement token, not a cross-chain
  Arc deposit), so this is a plain same-chain balance/escrow read, not
  another cross-chain trust question.
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

**No `VerdictWritten` collision, by construction now.** Under the earlier
relay design, settling GenLayer's outcome through Arc's verdict path would
have collided with `VerdiktRegistry.sol`'s `_recordVerdict`, which rejects
outright: `if (_verdicts[requestId].writtenAt != 0) { emit
VerdictRejected(..., DUPLICATE_REQUEST); return; }`. Moot now — semantic
settlement never touches `_verdicts` or Arc at all, so there is nothing to
collide with. Its own event lives entirely on GenLayer, in the settlement
token / claim contract's own state.

**The refund-cap double-dip concern, resolved by the currency split, not
just re-capped.** The earlier design had both CRE's refund and semantic
settlement drawing USDC from the same `service.deposit`, so a call getting
both a CRE `FAIL` and a semantic `BREACH` risked collecting two refunds past
`FIXED_REFUND`. That risk is gone by construction now: CRE's refund is
still USDC from Arc's `service.deposit`, semantic settlement is the custom
token from an entirely separate GenLayer-native pool. Two independent
remedies in two independent currencies from two independent pools — nothing
shared to double-spend against. Worth stating plainly as a real benefit of
the currency-separation decision, not just a side effect.

**Dashboard must show both, not collapse them.** A call's full record is
still one CRE verdict (Arc, USDC) plus zero or more semantic settlements
(GenLayer, custom token) — different chains and currencies now, if
anything a *stronger* reason not to collapse them into a single displayed
status. Folding them together would misrepresent exactly the case that
motivated this feature — CRE PASS, semantic BREACH.

**Reputation: a separate score, sourced from GenLayer now, not
`VerdictWritten`.** The existing `conformance`/`availability` ENS text
records are computed purely from Arc's `VerdictWritten` events
(Specification.md §1) and are already referenced in the frozen ETHOnline
submission's evidence — unaffected by any of this, since semantic
settlement never reaches Arc. A third score, e.g. `semanticConformance`
(same 1000-when-empty convention, its own ENS signer role), would now be
aggregated by reading GenLayer's own settlement events/state via its RPC,
not an Arc log scan — a genuinely different aggregation mechanism from the
existing hourly workflow, not a drop-in extension of it. Leaving it
unaggregated anywhere still means semantic failures never affect a
provider's advertised standing — same gap, different plumbing to fill it.

### Withdrawal cooldown: still needed, now single-chain

The underlying problem is unchanged, just relocated: whatever holds a
provider's semantic-claims deposit must not let it be withdrawn instantly,
or a provider can post the deposit, take calls, and withdraw before a
consumer ever files — the same escape route originally found in
`VerdiktRegistry.deregister()` (still real, still worth knowing: while
`ACTIVE`, a provider can deregister and pull their **entire deposit,
immediately, unconditionally**), just now against the new GenLayer-native
settlement token's deposits instead of Arc's.

**Materially simpler now.** This used to be a retrofit onto an
already-deployed, currently-uncooled-down Arc contract with real state —
now it's a cooldown designed into a brand-new GenLayer contract from the
start, on a single chain, no cross-chain migration question at all.

**Fix, specified, not yet implemented:**
- Deregistration/withdrawal moves to a pending status with a cooldown
  safely exceeding the filing + adjudication window (e.g. 72h, well past
  the 24h + ~3h GenLayer appeal figures already in play elsewhere in this
  doc).
- Settlement re-clamps against the deposit's *current* balance at credit
  time, not one checked earlier — handles concurrent liabilities if
  multiple claims draw on the same provider's pool.
- Insufficient funds clamp to whatever remains rather than reverting — the
  judgment (`MET`/`BREACH`/`UNDETERMINED`/`CANCELLED`) is always recorded
  regardless of whether funds backed it, same split CRE already has between
  verdict and payout.

### Deployment: entirely new contracts on GenLayer, Arc untouched

**Simplified by the same currency decision.** The earlier "companion
contract, not an extension" analysis is now moot in its original form —
there is no Arc-side contract to deploy at all. `VerdiktRegistry` stays
exactly as it is on Arc Testnet
(`0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af`), untouched, no migration
question for its existing bonds, refunds, or registrations, because nothing
new is deployed there. Everything new — the settlement token, the
bonding/escrow logic — deploys fresh on GenLayer, which has no live state to
protect yet. The "shared bond suspends CRE-judged calls" risk from the
companion-contract design doesn't apply either: GenLayer's settlement pool
and Arc's `service.deposit` are different chains now, not just different
contracts, so there is no shared balance to drain in the first place.

The only Arc dependency left is a read (`getVerdict()`, eligibility gate,
above) — no write, no deployment, no migration.

### Claimant interface: not yet owned by any issue

#85 correctly treats a live settlement as optional for a first smoke test.
But #86 (submission assets) only asked for a deployed judge — a hackathon
reviewer needs to actually *use* the claim flow, not take deployment on
faith. Nothing currently owns: a claimant-facing CLI (mirroring
`scripts/pay-x402.mjs`'s existing pattern — a real interactive script, not a
UI, given the time remaining) for minting test settlement tokens, opening a
claim, posting a bond, checking status, and withdrawing once settled — all
against GenLayer now, no Arc-side withdrawal step for this path. Tracked as
its own issue.

**Acceptance criteria for the demo, explicit:**
- A claim that resolves `BREACH` (successful claimant) *and* one that
  resolves `MET` (rejected claimant) — not just one happy path.
- Actual settlement-token balance read-back on GenLayer before and after
  settlement, not "the transaction didn't revert" — the same lesson this
  codebase already learned once about the KeystoneForwarder swallowing
  failures silently, applied to the new chain doing the paying.
- A demonstrated `CANCELLED` / infrastructure-failure recovery — the timeout
  path actually exercised, not just present in the contract.

### Economics: two separate accounting lines, both in the custom token now

"Refund plus GenLayer execution cost" was never actually specified — what
caps apply and what happens to a claimant's own bond were left open. Left
underspecified, an unbounded or self-reported cost claim against a
provider's deposit is the same shape of attack the refund cap already
exists to prevent. Re-specified for the GenLayer-native settlement token,
not USDC on Arc:

**Two lines, two independent caps, never merged:**

- **Compensation** — no longer literally "the refund" (that stays a CRE/
  Arc/USDC-only concern, untouched). Sized to numerically match the
  original `paidAmount` (read from Arc's `getVerdict()`, already needed for
  eligibility) in the custom token's own units — not a currency conversion,
  since the token isn't pegged to anything, just a legible number a demo
  can compare against the original payment. Capped the same shape as
  before: `min(compensation, remaining GenLayer-native deposit)`.
- **GenLayer execution-cost bounty** — a **fixed** amount in the same
  token (a protocol constant), not metered against actual gas spent —
  avoids both a price-tracking dependency and letting a self-reported cost
  claim an arbitrary amount. Same cap regardless of whether the claim
  escalated to GenLayer's own internal appeal jury.

**Who pays gas — simpler now, no relay to reimburse.** Since settlement
happens natively inside `resolve_claim` (via `.emit(on='finalized')` to the
settlement token, above), whoever calls `submit_claim`/`resolve_claim` —
realistically the claimant, through the CLI (#94) — pays their own GEN gas
directly, the same way any blockchain transaction works. No relay, so
nothing to front or reimburse as a separate step. The execution-cost bounty
still exists as a real line item: if the claimant wins, the provider's
deposit reimburses the gas they spent pursuing a valid claim; if the
claimant loses, their own bond absorbs it instead.

**Bond disposition, fully specified:**

- **Consumer wins (`BREACH`):** consumer's bond returned in full, untouched
  — they were right. Provider's GenLayer-native deposit pays the
  compensation plus the execution-cost bounty.
- **Consumer loses (`MET`):** consumer's bond pays the execution-cost
  bounty; any **surplus** above that fixed amount is returned to the
  consumer, never kept as a default. Deters frivolous claims without
  turning a lost claim into an uncapped penalty.
- **`UNDETERMINED`:** neither party's bond is charged — an evidence-envelope
  failure is upstream of both parties. The claimant still spent real gas on
  the attempt; for now that's an absorbed cost of trying, not passed to the
  provider. Flagging as a business-model decision to revisit, not settling
  it unilaterally here.
- **`CANCELLED`:** consumer's bond returned in full. A resolution that never
  happens is an infrastructure failure, not a judgment against the
  consumer.

**Timeout / cancellation path for infrastructure failure**, unchanged in
concept from the earlier design, now entirely single-chain: `cancel_claim`
(implemented, `genlayer/contracts/sla_claim_judge.py`) lets anyone close a
claim permissionlessly once a resolution timeout elapses since
`submit_claim`, returning the consumer's bond in full — mirrors GenLayer's
own permissionless idleness-call pattern for stalled validator rounds.

Settlement itself now happens inside `resolve_claim`, via the settlement
token's `.emit(on='finalized').transfer(...)` — not a relay, not a write to
Arc. Not yet built — the current contract still needs the settlement token
contract, the bonding logic in `submit_claim`, and the finalized-gated
payout in `resolve_claim` added. Tracked in the GitHub issues.

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
- [x] Judge acceptance criteria made explicit: bounded structured outcome
      (already had), independent validation (already had), prompt-injection
      delimiting + disclosure (new — untrusted content fenced, not a full
      solve), explicit `INCONCLUSIVE` path distinct from envelope-support
      failures (new)
- [x] `feat/genlayer` actually pushed to `origin` — was 10 commits local-only
      until reconciled with the real remote branch (which already existed,
      independently created); local checkout was also ~2.5 days stale
      against `origin/main`, corrected where it mattered (#82)
- [x] Direct-mode tests with mocked web/LLM (`genlayer/tests/direct/`)
- [x] Local reference clones: `genlayer-boilerplate`,
      `genlayer-studio-bridge-boilerplate`
- [ ] **Superseded architecture, not yet reflected in code:** the contract
      still assumes Arc-side USDC settlement via a relay. Needs: a
      GenLayer-native settlement token contract (permissionless `mint()`,
      balances), bonding wired into `submit_claim`, and `resolve_claim`
      paying out via `.emit(on='finalized').transfer(...)` instead of just
      recording an outcome. No relay to build at all — deleted from scope,
      not deferred.
- [ ] **Claim eligibility gate** — on-chain `getVerdict` **read** (registry
      address, real verdict exists, verified payer, service/slug match,
      filing deadline; bond-posted check is now same-chain, not
      cross-chain), currently entirely missing; anyone can call
      `submit_claim` against anyone's public `request_id` today
- [ ] Provider opt-in flag for semantic claims (ENS text record)
- [ ] Proxy response cache for opted-in services, `GET /internal/sla/<slug>`,
      and the dispute-gated `GET /internal/evidence/<request_id>` (returns
      nothing until `submit_claim` has opened a claim for that id)
- [ ] Consumer bonding + native settlement (`UNDETERMINED` releasing both
      bonds unspent) — entirely on GenLayer, no relay, no Arc write
- [ ] Claimant CLI (#94): mint test tokens, open a claim, post a bond, check
      status, withdraw
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
