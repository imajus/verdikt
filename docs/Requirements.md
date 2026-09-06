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
  JSON, per call.
- **Periodic availability score** — computed as a continuous uptime
  percentage (100% minus percentage downtime) over a rolling window, then
  mapped through a published tier table to a refund percentage, following
  the same tiered-credit approach used in commercial cloud SLAs[^5].

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

### 6.3 On-chain registry

- **Permissionless registration**: `register(serviceId)` on a registrar
  contract, posting the required deposit. `serviceId` = `keccak256` of a
  human-chosen slug. The same slug doubles as the `<slug>.verdikt.bond`
  routing subdomain and, if the §6.4 stretch goal ships, the
  `<slug>.verdikt.eth` ENS subname label — one identifier, reused everywhere,
  rather than a separate mapping table per surface.
- **Deposit/bond**: held in an escrow contract keyed by `serviceId`, paid in
  USDC, **fixed amount** for MVP (no reputation-scaled tiering). This is the
  pool refunds are paid from. Paid directly to escrow, not through the
  proxy.
- **SLA record**: provider writes one JSON blob (schema, max latency, min
  availability, cost, refund policy) to IPFS, pointed to by a string field
  on the registry struct. Mutable any time by the owner. This is what makes
  the verification logic generic — it diffs against whatever the provider
  committed to, not a hardcoded per-service check.
- **Two roles per service**: owner (can `setSLA`) and verifier (the CRE
  workflow's callback signer, can `setVerdict`). Neither the provider nor
  Verdikt itself can write a verdict — enforced at the contract level, not
  by convention.
- **Two refund paths, both auto-executed, no dispute step**:
  1. *Per-request*: a FAIL verdict for a specific paid request releases a
     fixed refund from that service's deposit to the paying agent
     automatically (the proxy already correlates request↔payment↔verdict).
  2. *Periodic availability*: at each monitoring window's end, if computed
     uptime falls below the SLA's advertised availability, a refund
     percentage from the tier table (§6.1) is distributed pro-rata from
     the deposit to everyone who paid during that window.
- **Auto-suspend at zero**: once refunds drain a service's deposit to 0,
  the registrar flips status to SUSPENDED and the proxy stops routing new
  payments to it until topped up — no governance step.
- **Reading**: any agent or dApp checks a service's SLA/reputation via view
  functions (`getSLA`, `getVerdict`, `getDeposit`). A minimal JS SDK (or
  thin REST wrapper) should ship alongside the contract to keep integration
  cost low.
- **History**: standard events (`SLAUpdated`, `VerdictWritten`) on every
  write — verdict history is replayable directly off an RPC node, no
  subgraph dependency.

### 6.4 ENS integration (stretch goal)

Verdikt uses `verdikt.eth` as a namespace for provider identity:

- Each API provider registers a **subname** under `verdikt.eth` (e.g.
  `provider-name.verdikt.eth`) to represent their listed service. The label
  is the same human-chosen slug used for the on-chain `serviceId` (§6.3),
  so `provider-name.verdikt.bond/<path>` — the URL agents actually
  call — maps directly to `provider-name.verdikt.eth` with no separate
  lookup table: wildcard routing on `*.verdikt.bond` resolves the
  subdomain label straight to both the registry entry and the ENS subname.
- The subname carries two records:
  - A **custom text record** holding (or pointing to, e.g. via an IPFS
    hash) the provider's SLA JSON.
  - An **address record** set to the API provider's owner/payout wallet.
- At payment time, the CRE workflow resolves the subname's address record
  and compares it against the `payTo` address in the live x402 402
  response. A mismatch blocks payment before it is sent — this must be a
  pre-payment gate, not a post-hoc verdict like the checks in §6.1, because
  once an agent pays a spoofed address there is no bonded deposit to
  reclaim it from.
- Build the core (§6.1–§6.3) first; attempt this only if time remains.

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
   | relays 402 challenge; [stretch] checks verdikt.eth payTo record
   | before payment; triggers a workflow run once payment settles
   v
Chainlink CRE Confidential Workflow (TEE)
   - fetches the provider's API response directly, inside the enclave
   - resolves provider's SLA JSON (IPFS)
   - diffs observed response vs SLA -> PASS/FAIL + availability score
   - releases the response payload to the calling agent
   - posts only the signed verdict on-chain
   |
   v
On-chain registry (Arc)
   - SLA record, verdict, deposit balance, roles
   - auto-refund on FAIL / low availability
   - auto-suspend at zero deposit
   |
   v
Dashboard — reads registry via SDK/view functions
```

## 8. Target chain & stack

- **Chain**: Arc, Circle's stablecoin-native L1.
- **Verification compute**: Chainlink CRE Confidential Workflows.
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
- **Open** — one slot unfilled. ENS is a candidate for this slot only if
  the §6.4 stretch goal ships.

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
