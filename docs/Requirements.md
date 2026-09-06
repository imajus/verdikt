# Verdikt

## 1. Problem

x402 (HTTP-native pay-per-call payments) has no verification layer. The
Facilitator settles payment; the Bazaar directory is self-reported discovery.
Neither checks that a paid-for API call actually delivered what the provider
advertised. A 2026 security study of 15 major x402 facilitators — covering
roughly 99% of observed volume, including Coinbase — found that all 15
violated at least one security rule across 31 distinct vulnerabilities[^1].
This is live evidence that "payment settled ≠ service delivered correctly"
is a real, current gap, not a hypothetical.

ERC-8004 ("Trustless Agents") already defines an Identity/Reputation/
Validation registry pattern for agents, and its own spec text admits it
"cannot cryptographically guarantee that advertised capabilities are
functional and non-malicious"[^2]. A 2026 study found zero confirmed mainnet
deployments of its Validation Registry[^3]. The standard exists; nobody has
built the missing piece.

## 2. Product summary

Verdikt is an automated, judgment-independent reputation and refund system
for x402-gated APIs. A proxy sits between a paying agent and an x402
service, verifies the response against the provider's own declared SLA
inside a Chainlink CRE Confidential Workflow (TEE), writes a verdict to an
on-chain registry, and auto-refunds the paying agent from the provider's
bonded deposit when the SLA isn't met — with no dispute or arbitration step.

Verification and refund are both code-enforced, so trust in the result does
not depend on either party's judgment.

## 3. Goals

- Prove that x402 API delivery can be verified automatically, without a
  human-run dispute process, using a provider's own machine-readable SLA.
- Demonstrate two distinct, appropriately-matched verdict types in one
  system: a **boolean** per-call verdict for discrete conformance clauses,
  and a **graduated** score for an aggregate/continuous property
  (availability).
- Ship a real, live, end-to-end demo (register → verify → refund → query)
  on a public testnet, with a dashboard that visualizes it.
- Fit within a solo 2-week build.

## 4. Non-goals (explicitly out of scope for MVP)

- **Ground-truth fact-checking** — verifying that a response is *factually
  correct* (e.g. re-deriving a claimed exchange rate). Scope is
  conformance/delivery verification only (schema, latency, price,
  availability), not epistemic correctness.
- **Dispute/arbitration layer** — no challenge process. A CRE verdict is
  final and auto-executes a refund; this is a deliberate design choice (see
  §6.2), not a shortcut.
- **Weighted multi-clause scoring engine** — no single 0–1 compliance score
  blending every clause. Boolean clauses stay boolean; only availability is
  graduated (see §6.1 for the reasoning behind this split).
- **Reputation-scaled deposit tiers** — deposit is a fixed amount per
  service for MVP.
- **Deposit-via-x402** — the bond is paid directly to the escrow contract,
  not routed through the x402 proxy.
- **Re-derivation/challenge of a CRE verdict** — x402 responses are
  pay-gated, so there is no free, public source of truth a challenger could
  use to re-check a claim. The bond substitutes for re-derivation.

## 5. Users

1. **API providers** — register an x402-gated service, post a bond, publish
   an SLA. Want a way to prove trustworthiness beyond a self-reported
   listing.
2. **Paying agents** — call registered services, get auto-refunded on
   SLA violations without filing a claim.
3. **Anyone doing due diligence** — a human or agent checking a service's
   live SLA, verdict history, and deposit balance before integrating.

## 6. Functional requirements

### 6.1 SLA verification model

Verdikt verifies two categories of guarantee using one evaluation stack,
adapted from IBM's WSLA per-guarantee predicate model[^4]:

- **Per-request boolean verdict (PASS/FAIL)** — schema/input-output
  conformance, latency, and price range are each evaluated as an
  independent true/false predicate against the provider's declared SLA
  JSON, per call. Each result is emitted as a `VerdictWritten` event on Arc
  (§6.3) — this is the raw, per-call record; nothing per-call is published
  beyond Arc.
- **Periodic availability score** — computed as a continuous uptime
  percentage (100% minus percentage downtime) over a trailing window, then
  mapped through a published tier table to a refund percentage, following
  the same tiered-credit approach used in commercial cloud SLAs[^5].

Both scores are recomputed **hourly**, each run reading the trailing
**7-day** window of `VerdictWritten` events (a rolling window, refreshed
every hour, not a fixed weekly cutoff) rather than published per call:
- **SLA conformance ratio** — PASS count ÷ total calls in the trailing
  7 days, expressed on a **0–1000 scale** (e.g. 987 = 98.7% conformance)
  rather than a percentage, since ENS text records are strings and an
  integer avoids decimal-formatting ambiguity.
- **Availability ratio** — the same 0–1000 scale applied to the uptime
  percentage above.

Publishing per-call would mean one ENS write per request; an hourly
rolling-window ratio means at most one ENS write per service per hour
regardless of call volume — still far cheaper than per-call, and a fresher
reputation signal than a weekly one, while still describing a week-long
track record rather than a single call. The per-call events remain the
ground truth on Arc; the ratios are a derived, hourly-refreshed summary
(§6.4). Because the window is rolling and overlaps between runs, the refund
side of this (§6.3) has to pay out only the *new* shortfall each hour, not
re-settle the whole trailing week every run — see §6.3 for how that's kept
idempotent.

Both mechanisms share one evaluation engine and one SLA schema — this is a
single verification stack, not a menu of interchangeable approaches. The
formal basis for mixing a boolean-per-clause model with a graduated
aggregate metric inside one agreement, rather than forcing a uniform
scoring approach across every clause, comes from Rana et al.'s taxonomy of
SLA violation types (all-or-nothing / partial / weighted-partial)[^6].

Other approaches exist in the literature — rule-based SLA engines[^7] and
zero-knowledge or TEE-attested compliance proofs[^8] — and are cited here
for reference, but Verdikt commits to the WSLA-predicate plus tiered-credit
stack above as its single verification model for this build.

#### Why a neutral middleman, not caller-side evaluation

An alternative design would let the paying agent evaluate compliance itself
and decide whether to claim a refund. This is simpler to build but
structurally weak: the agent has a direct financial incentive to claim
non-compliance regardless of the actual response, the provider has no way
to contest a false claim without an arbitration process, and neither
party's evaluation is auditable by anyone else.

Verdikt instead runs the compliance check inside a neutral, deterministic
middleman. The same SLA JSON evaluated against the same observed response
produces the same verdict regardless of who is asking; the verifier role is
code-enforced and held by neither the provider nor the calling agent (see
§6.3); and the resulting verdict is written on-chain, so any third party can
trust it without having to trust the agent or the provider individually.
This is what makes the reputation system judgment-independent: compliance
is a deterministic function of (SLA, response), evaluated once by an
unbiased third party, not negotiated or self-reported by either side.

### 6.2 Verification execution — Chainlink CRE Confidential Workflows

Verification runs inside a Chainlink CRE Confidential Workflow (TEE). Critically,
the **workflow itself makes the outbound HTTP call to the provider's API** —
Verdikt's own proxy/backend never receives or terminates the provider's
response. If Verdikt's infrastructure fetched the response and only then
handed it to the enclave for diffing, the response would already have been
exposed to a party outside the enclave and the confidentiality guarantee
would be void before verification even started. Confidentiality has to be
enforced at the point of fetch, not after.

This is essential, not incidental. API responses frequently contain
proprietary, licensed, or otherwise valuable data — market data feeds,
proprietary model outputs, personal data — that a provider has a legitimate
interest in keeping confidential even from the verification layer itself.
Because the enclave performs the fetch directly, Verdikt itself never gains
visibility into response content, only the derived boolean/graduated
verdict: the provider's data stays private through verification, not just
through settlement.

The workflow architecture is: the enclave fetches the provider's API
response directly (with any request credentials kept encrypted in-enclave),
evaluates the independent checks described in §6.1, merges the results,
releases the response payload to the calling agent, and posts only a
signed verdict on-chain — per
[Chainlink's CRE template pattern](https://docs.chain.link/cre-templates/ai-audit-firewall),
where the confidential workflow itself sits directly in front of the
sensitive call rather than receiving already-exposed data. Verdikt's own
backend is reduced to a thin coordinator: it handles the x402 protocol
handshake (relaying the 402 challenge, correlating payment to request) and
triggers the workflow run, but never decrypts or logs a provider response
body.

Production CRE enrollment is currently private-beta; `cre workflow
simulate` is self-serve, and the ETHOnline2026 Chainlink track explicitly
accepts CLI simulation as sufficient evidence — not a build blocker.

#### Two workflows, not one

Everything above describes the **per-request** workflow — proxy-triggered,
right after payment settles, and confidential because it's the one touching
the provider's actual response. The per-request refund path (§6.3) is
triggered directly from this workflow's own PASS/FAIL result: same run,
same trust boundary, no hand-off.

The **hourly** reputation/refund-checkpoint run (§6.1, §6.3) is a
**separate** CRE workflow, on a scheduler/cron trigger rather than a
per-request one. It never touches a provider response — it only reads
`VerdictWritten` events that are already public on Arc — so it has no
confidentiality requirement and doesn't run inside the TEE. It's a plain
CRE workflow whose job is aggregation: compute the trailing-7-day ratios,
settle the idempotent shortfall refund via the checkpoint, write to ENS.
This split is a directly supported CRE pattern, not a workaround:
confidentiality is an optional, layered feature of a workflow, not a
property every CRE workflow must have, and the Cron trigger is a first-class
standard trigger type alongside HTTP and on-chain-event triggers[^10].

The two are deliberately not merged: piggybacking the hourly aggregate onto
whichever per-request run happens to land within an hour would make the
aggregate depend on traffic timing (an hour with zero calls would just
never publish), and would put non-confidential aggregation logic inside the
one workflow that has to justify running as a TEE. A dedicated
scheduler-triggered workflow avoids both.

### 6.3 On-chain registry

- **Permissionless registration**: `register(serviceId)` on a registrar
  contract, posting the required deposit. `serviceId` = `keccak256` of a
  human-chosen slug. The same slug doubles as the `<slug>.verdikt.bond`
  routing subdomain and the `<slug>.verdikt.eth` ENS subname label (§6.4) —
  one identifier, reused everywhere, rather than a separate mapping table
  per surface.
- **Deposit/bond**: held in an escrow contract keyed by `serviceId`, paid in
  USDC, **fixed amount** for MVP (no reputation-scaled tiering). This is the
  pool refunds are paid from. Paid directly to escrow, not through the
  proxy.
- **No SLA storage on Arc**: the registry struct has no SLA field and there
  is no `setSLA` function. The SLA lives in exactly one place — the
  provider's ENS subname (§6.4) — so there is nothing on Arc that could
  drift out of sync with it. The verification workflow reads the SLA
  straight from ENS at run time; this is what makes the verification logic
  generic, since it diffs against whatever the provider committed to on
  ENS, not a hardcoded per-service check or a second, Arc-side copy.
- **One role per service**: verifier only (the CRE workflow's callback
  signer, can `setVerdict`). Neither the provider nor Verdikt itself can
  write a verdict — enforced at the contract level, not by convention. The
  provider has no write role on Arc at all; their authorship happens
  entirely on the ENS side (§6.4).
- **Two refund paths, both auto-executed, no dispute step**:
  1. *Per-request*: a FAIL verdict for a specific paid request releases a
     fixed refund from that service's deposit to the paying agent
     automatically (the proxy already correlates request↔payment↔verdict).
  2. *Periodic availability*: an **hourly** scheduled CRE run reads the
     trailing 7 days of `VerdictWritten` events, computes the conformance
     and availability ratios (§6.1), and writes both to the provider's ENS
     subname (§6.4) — one run, one ENS update. Because the 7-day window
     rolls forward and overlaps between hourly runs, the refund side tracks
     a per-service "refunded up to" timestamp on Arc: each run only
     distributes a pro-rata refund for the *new* shortfall since that
     checkpoint (not the full trailing week again), then advances the
     checkpoint — so an hourly cadence can't pay out the same violation
     more than once.
- **Auto-suspend at zero**: once refunds drain a service's deposit to 0,
  the registrar flips status to SUSPENDED and the proxy stops routing new
  payments to it until topped up — no governance step.
- **Reading**: any agent or dApp checks a service's verdict/deposit via view
  functions (`getVerdict`, `getDeposit`) on Arc, and its SLA by resolving
  the ENS subname directly (§6.4) — there's no `getSLA` on Arc, since Arc
  never held it. A minimal JS SDK (or thin REST wrapper) should ship
  alongside the contract to keep integration cost low, and should wrap both
  lookups so callers don't need to know two chains are involved.
- **History**: a standard `VerdictWritten` event on Arc for verdict history,
  replayable directly off an RPC node with no subgraph dependency. SLA edit
  history is likewise free — ENS's own `TextChanged` event on the
  Permissioned Resolver (Sepolia) already covers it; no custom event
  needed.

### 6.4 ENS integration — the SLA source of truth

Verdikt targets **ENSv2 exclusively** — the Permissioned Registry and
Permissioned Resolver — not ENSv1. This is a deliberate narrowing, not an
oversight: ENSv2's Enhanced Access Control (EAC) lets a resolver scope write
permission down to a single text-record key via
`authorizeTextRoles(name, key, account, grant)`, so an address can be
granted the right to write *only* the `sla` key, or *only* the `conformance`/
`availability` keys, with any other key reverting for that address. ENSv1's
PublicResolver has no equivalent — any approved operator on a name can write
any text key — so it cannot make the guarantee this design depends on: the
provider can write their own SLA, the CRE verifier can write the reputation
ratios, and neither can touch the other's key, enforced by the resolver
contract itself rather than by convention.

That per-key ACL is why the SLA now lives **only** on ENS, with no second
copy anywhere. Earlier drafts had the provider write the SLA to Arc's
registry and mirror it to ENS; that's a two-copy design with nothing
enforcing they stay identical. With EAC scoping the SLA text record, Arc's
registry doesn't need to store the SLA at all (§6.3) — the ENS record simply
*is* the SLA, and the CRE workflow reads it from there directly at
verification time.

The trade-off, stated plainly: ENSv2 has no mainnet deployment, so this
namespace runs on **Sepolia**, not mainnet. Verdikt's identity/SLA layer is
therefore a testnet component alongside Arc's own testnet, not a
`verdikt.eth` mainnet name — an accepted scope decision for a two-week
build, not something to gloss over in the submission.

- Each API provider registers a **subname** under `verdikt.eth` on the
  ENSv2 Permissioned Registry (Sepolia), e.g. `provider-name.verdikt.eth`.
  The label is the same human-chosen slug used for the on-chain `serviceId`
  (§6.3), so `provider-name.verdikt.bond/<path>` — the URL agents actually
  call — maps directly to `provider-name.verdikt.eth` with no separate
  lookup table.
- At mint time, the resolver's EAC roles are set: the provider's address
  gets a role scoped to the `sla` key only; the CRE workflow's signer
  address gets a role scoped to the `conformance` and `availability` keys
  only. This is a one-time authorization at registration, not a per-write
  step.
- The subname carries four records:
  - An **`sla` text record**, written directly by the provider, any time,
    with no Arc involvement — the sole copy of the SLA (§6.3).
  - A **`conformance` text record** — the SLA conformance ratio (0–1000,
    §6.1), and an **`availability` text record** — the availability ratio
    (0–1000, §6.1), both written by the CRE workflow's signer **hourly**,
    over the trailing 7-day window (§6.1), not per call. This is the same
    scheduled run that checks Arc's periodic refund path (§6.3), so it's
    the only thing that fans out to both chains from one workflow
    execution — the per-call PASS/FAIL verdicts stay Arc-only events
    (§6.1) and never touch ENS individually.
  - An **address record**, owner-controlled, set to the provider's
    payout wallet.
- At payment time, the CRE workflow resolves the subname's address record
  and compares it against the `payTo` address in the live x402 402
  response. A mismatch blocks payment before it is sent — this must be a
  pre-payment gate, not a post-hoc verdict like the checks in §6.1, because
  once an agent pays a spoofed address there is no bonded deposit to
  reclaim it from.
- The CRE workflow reads the live `sla` text record straight from the
  Permissioned Resolver (Sepolia) as its verification input — there is no
  IPFS pointer or Arc-side field to go stale or drift out of sync with what
  the provider actually published on ENS.

### 6.5 Product / dashboard

- **MVP**: a platform dashboard (own web UI) showing aggregate stats —
  services registered, verdict breakdown (PASS/FAIL), deposits held,
  refunds paid out over time. This is the primary demo surface, not just
  backend contracts.
- **Stretch, in priority order**:
  1. Provider self-serve dashboard (own verdict history, deposit balance,
     SLA-JSON editor).
  2. Discovery UI/API — human browse/search plus a machine-facing discovery
     API for agents filtering by cost/latency/availability.

## 7. Architecture summary

```
Paying agent
   |
   v
Verdikt proxy (thin coordinator — handshake + payment/request
correlation only; never decrypts or logs a provider response)
   |
   | relays 402 challenge; checks verdikt.eth payTo record before
   | payment; triggers a workflow run once payment settles
   v
Chainlink CRE Confidential Workflow (TEE) -- per-request run
   - fetches the provider's API response directly, inside the enclave
   - resolves provider's live SLA from the ENS Permissioned Resolver
     (Sepolia, verdikt.eth) -- the sole copy, nothing on Arc to drift
   - diffs observed response vs SLA -> PASS/FAIL
   - releases the response payload to the calling agent
   - writes PASS/FAIL to Arc as a `VerdictWritten` event (refund trigger
     if FAIL) -- Arc only, no per-call ENS write
   |
   v
On-chain registry (Arc)
   - verdict events, deposit balance -- no SLA field
   - auto-refund on per-request FAIL
   - auto-suspend at zero deposit

Chainlink CRE Workflow (plain, no TEE) -- separate, hourly, trailing 7 days
   - reads VerdictWritten events from the trailing 7-day window on Arc
   - computes conformance ratio + availability ratio (0-1000 each)
   - refunds only the new shortfall since Arc's "refunded up to" checkpoint
     (avoids re-paying the same violation across overlapping runs)
   - writes both ratios to the ENS subname (Sepolia)
   |
   v
ENS subname (Sepolia, verdikt.eth, ENSv2 Permissioned Registry/Resolver)
   - `sla` text record (owner-authored, EAC-scoped to owner only)
   - `conformance` / `availability` text records (CRE-authored,
     EAC-scoped to CRE signer only, refreshed hourly not per call)
   - address record (payout wallet)
   |
   v
Dashboard — reads verdict events/deposit from Arc, SLA + ratios from ENS
```

## 8. Target chain & stack

- **Chain**: Arc, Circle's stablecoin-native L1.
- **Verification compute**: Chainlink CRE — a Confidential Workflow (TEE)
  per request, plus a separate plain (non-confidential) scheduled workflow
  for the hourly reputation aggregate (§6.2).
- **Storage**: IPFS for SLA JSON blobs.
- **Payments**: x402, settled in USDC.

Verdikt is a natural fit for Arc's agent-commerce ecosystem specifically:
Circle's own [agent marketplace](https://agents.circle.com/sell) lets
providers list x402 endpoints for agents to discover and pay, and scores an
endpoint's "agent-readiness" before it goes live (e.g.
[agents.circle.com/sell/score?url=nano.blockrun.ai](https://agents.circle.com/sell/score?url=nano.blockrun.ai)).
That scoring step checks whether an endpoint is *structurally* ready to be
listed — it does not check whether a listed endpoint keeps delivering what
it promised after it's live and being paid per call. Verdikt is the missing
piece downstream of listing: ongoing, automatic verification of delivery
against a provider's own SLA, with code-enforced refunds when it falls
short.

## 9. Prize track fit

Submission constraint: max 3 Partner Prizes selectable (a partner's
multiple tracks count as one slot).

- **Chainlink** — confirmed. CRE is the verification engine itself.
- **Arc** — confirmed. Chain the registry and demo API run on.
- **ENS** — confirmed. `verdikt.eth` subnames on ENSv2's Permissioned
  Registry/Resolver are the SLA source of truth and reputation-interface
  layer (§6.4), using Enhanced Access Control's per-key role scoping —
  not an optional add-on, and not just a naming convenience.

## 10. Competitive landscape

- **x402-list.com** — closest existing competitor. Tracks 600+ x402
  services via uptime probing and a protocol-compliance checklist
  (structural, not claim verification), and already sells a paid
  verification badge[^9] — evidence that willingness-to-pay for
  verification exists today. No confidential-compute angle; Verdikt's
  differentiator is verifying actual response content against a
  provider-declared SLA, privately, not just probing uptime.
- **x402disputes.com** and **x402r.org** — both address x402 refunds, but
  via manual dispute/arbitration: a party files a dispute with evidence
  (x402disputes.com) or an escrow with a pluggable arbiter resolves a claim
  (x402r.org). Verdikt's core distinction from both is that it never
  invokes a human or third-party arbiter — the verdict is a deterministic,
  automatic function of the SLA and the observed response (§6.1), with no
  dispute step at all.
- **Edge & Node's ampersend** — an agent-payment dashboard on x402 + A2A +
  ERC-8004 covering budget limits and allowlists; a human-configured
  spend-management tool, not an automated verification/reputation proxy.

## 11. Open risks / unresolved

- The demo API's x402 integration and response schema not yet confirmed as
  a good verification target — may need a thinner/different demo API.
- An x402-capable wallet CLI for Arc is referenced as available but not yet
  named/tested.
- Availability tier boundaries/percentages may need tuning during build.
- Cross-chain delivery on the hourly run (Arc refund checkpoint update +
  ENS `conformance`/`availability` records on Sepolia from one CRE run)
  needs a defined behavior for partial failure — e.g. the Arc checkpoint
  advances but the Sepolia write doesn't land — not yet designed. Lower
  stakes than a per-call design (once an hour, not once a request), but an
  hourly cadence runs 168x more often than a weekly one, so this failure
  mode is worth resolving early rather than deferring; the SLA path has no
  equivalent risk at all, since it's never written by CRE.
- The "refunded up to" checkpoint on Arc (§6.3) that keeps hourly,
  overlapping 7-day-window refund runs idempotent is a new piece of state
  that doesn't exist in a simpler non-overlapping-window design — needs to
  be implemented and tested for the case where an hourly run is missed or
  runs late (does the next run correctly catch up the gap without
  double-refunding?).
- ENSv2's Permissioned Registry/Resolver are beta: exact deployed
  Sepolia addresses, ABI stability, and tooling support (viem/ethers/ENS
  SDK) not yet verified against the current build. Since the SLA now has no
  Arc-side fallback, this dependency needs to be confirmed early, not
  discovered mid-build.
- Verdikt's identity/SLA layer runs on Sepolia (ENSv2 has no mainnet
  deployment), separate from Arc's own network — should be stated
  explicitly in the submission as a scope decision, not left implicit.
- verdikt.bond domain not yet purchased — price/listing legitimacy
  unverified.
- No dispute layer is a deliberate design choice, and should be stated
  explicitly and confidently in the submission, not hedged.

[^1]: A 2026 security study (reported via CryptoSlate) tested 15 major x402
    facilitators, including Coinbase, and found all 15 violated at least
    one security rule across 31 distinct vulnerabilities (free-shopping,
    asset theft, sponsor-gas abuse).
[^2]: ERC-8004, "Trustless Agents" (Aug 2025, mainnet-introduced Jan 29
    2026), defines Identity/Reputation/Validation registries for agents;
    its spec text acknowledges it cannot cryptographically guarantee that
    advertised capabilities are functional and non-malicious.
[^3]: An arXiv study found zero confirmed mainnet deployments of ERC-8004's
    Validation Registry as of its study period (through May 2026).
[^4]: IBM's WSLA (Web Service Level Agreement language) ships a reference
    implementation, "SLA Compliance Monitor," in IBM's Web Services
    Toolkit, which evaluates every guarantee as an independent true/false
    predicate and auto-configures itself from a machine-readable SLA spec
    on receipt.
[^5]: E.g. AWS computes a continuous "Monthly Uptime Percentage" over a
    billing window and maps it to a graduated credit table (its EC2
    Region-Level SLA: 99.0–99.99% → 10% credit, 95.0–98.99% → 30%, <95.0% →
    100%) rather than a single cliff.
[^6]: Rana, Warnier, Quillinan, Brazier & Cojocarasu, "Managing Violations
    in Service Level Agreements," *Grid Middleware and Services* (Springer,
    2008). [DOI: 10.1007/978-0-387-78446-5_23](https://doi.org/10.1007/978-0-387-78446-5_23).
[^7]: RBSLA (Rule-Based SLA) — a four-layer rule-engine implementation
    (Prova rule engine, ContractLog KR, RBSLA markup, RBSLM tool) for
    declarative, rule-based SLA compliance.
[^8]: E.g. "Towards Trusted Service Monitoring: Verifiable Service Level
    Agreements" (arXiv:2510.13370, ICSOC 2025), which monitors SLA clauses
    inside TEEs with a zkVM circuit per SLO; and US Patent 12,494,976
    ("Zero-Knowledge Service Level Agreement (SLA) Monitoring," granted
    Dec 2025), which uses non-interactive zero-knowledge proofs.
[^9]: x402-list.com sells a self-serve verification badge for $0.25/check,
    with its methodology published at x402-list.com/methodology.
[^10]: Chainlink's [Confidential Workflows](https://docs.chain.link/cre/concepts/confidential-workflows)
    docs describe confidentiality as an optional, layered feature carved
    out of a standard workflow, not a requirement of every CRE workflow;
    the [Trigger Capability](https://docs.chain.link/cre/capabilities/triggers)
    docs list the Cron trigger as a standard, first-class trigger type
    alongside HTTP and on-chain EVM Log triggers.
