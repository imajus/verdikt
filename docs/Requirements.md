# Verdikt

## 1. Problem

x402 (HTTP-native pay-per-call payments) has no verification layer. The
Facilitator settles payment; the Bazaar directory is self-reported discovery.
Neither checks that a paid-for API call actually delivered what the provider
advertised. A 2026 security study of 15 major x402 facilitators — covering
roughly 99% of observed volume, including Coinbase — found all 15 violated at
least one security rule across 31 distinct vulnerabilities[^1]: payment
settling correctly does not mean the service delivered correctly.

ERC-8004 ("Trustless Agents") defines an Identity/Reputation/Validation
registry pattern for agents; its own spec text acknowledges it cannot
cryptographically guarantee advertised capabilities are functional and
non-malicious[^2], and a 2026 study found zero confirmed mainnet deployments
of its Validation Registry[^3].

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
- **Dispute/arbitration layer** — no challenge process; a CRE verdict is
  final and auto-executes a refund (spec §2).
- **Weighted multi-clause scoring engine** — no single 0–1 compliance score
  blending every clause; boolean clauses stay boolean, only availability is
  graduated (spec §1).
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

## 6. System overview

Verdikt is four subsystems working together; full mechanics, data flow, and
the architecture diagram live in `docs/specification.md`.

- **SLA verification** — a per-request boolean verdict for discrete
  conformance clauses (schema, latency, price), plus a periodic graduated
  availability score, both evaluated against the provider's own declared
  SLA (spec §1).
- **Verification execution** — a Chainlink CRE Confidential Workflow (TEE)
  fetches the provider's response directly and evaluates it, so Verdikt's
  own infrastructure never sees response content (spec §2).
- **On-chain registry** — a registrar/escrow contract on Arc holds each
  provider's bonded deposit, records verdicts, and auto-executes refunds
  with no dispute step (spec §3).
- **ENS integration** — each provider's SLA and derived reputation ratios
  live on an ENSv2 subname (`<slug>.verdikt.eth`), the sole source of truth
  the CRE workflow reads at verification time (spec §4).
- **Dashboard** — a web UI surfacing aggregate verdict/refund/deposit stats
  as the primary demo surface (spec §5).

## 7. Target chain & stack

- **Chain**: Arc, Circle's stablecoin-native L1.
- **Verification compute**: Chainlink CRE — a Confidential Workflow (TEE)
  per request, plus a separate plain (non-confidential) scheduled workflow
  for the hourly reputation aggregate (spec §2).
- **Storage**: no separate storage layer for the SLA — it's written directly
  as the ENS `sla` text record (spec §4), an arbitrary UTF-8 string per
  ENSIP-5[^4], not an IPFS-pointed blob. Simpler to implement than an
  IPFS-plus-hash-record design, and the write is infrequent (registration
  and occasional edits, not per call), so on-chain string-storage cost is
  acceptable.
- **Payments**: x402, settled in USDC.

Verdikt is a natural fit for Arc's agent-commerce ecosystem: Circle's own
[agent marketplace](https://agents.circle.com/sell) lets providers list
x402 endpoints for agents to discover and pay, and scores an endpoint's
"agent-readiness" before it goes live (e.g.
[agents.circle.com/sell/score?url=nano.blockrun.ai](https://agents.circle.com/sell/score?url=nano.blockrun.ai)).
That scoring step checks whether an endpoint is structurally ready to be
listed — it does not check whether a listed endpoint keeps delivering what
it promised after it's live and being paid per call. Verdikt is the missing
piece downstream of listing: ongoing, automatic verification of delivery
against a provider's own SLA, with code-enforced refunds when it falls
short.

## 8. Prize track fit

Submission constraint: max 3 Partner Prizes selectable (a partner's
multiple tracks count as one slot).

- **Chainlink** — confirmed. CRE is the verification engine itself.
- **Arc** — confirmed. Chain the registry and demo API run on.
- **ENS** — confirmed. `verdikt.eth` subnames on ENSv2's Permissioned
  Registry/Resolver are the SLA source of truth and reputation-interface
  layer (spec §4), using Enhanced Access Control's per-key role scoping.

## 9. Competitive landscape

- **x402-list.com** — closest existing competitor. Tracks 600+ x402
  services via uptime probing and a protocol-compliance checklist
  (structural, not claim verification), and already sells a paid
  verification badge[^5] — evidence that willingness-to-pay for
  verification exists today. No confidential-compute angle; Verdikt's
  differentiator is verifying actual response content against a
  provider-declared SLA, privately, not just probing uptime.
- **x402disputes.com** and **x402r.org** — both address x402 refunds, but
  via manual dispute/arbitration: a party files a dispute with evidence
  (x402disputes.com) or an escrow with a pluggable arbiter resolves a claim
  (x402r.org). Verdikt never invokes a human or third-party arbiter — the
  verdict is a deterministic, automatic function of the SLA and the
  observed response (spec §1).
- **Edge & Node's ampersend** — an agent-payment dashboard on x402 + A2A +
  ERC-8004 covering budget limits and allowlists; a human-configured
  spend-management tool, not an automated verification/reputation proxy.

## 10. Open risks / unresolved

- The demo API's x402 integration and response schema not yet confirmed as
  a good verification target — may need a thinner/different demo API.
- An x402-capable wallet CLI for Arc is referenced as available but not yet
  named/tested.
- Availability tier boundaries/percentages may need tuning during build.
- Cross-chain delivery on the hourly run (Arc checkpoint update + ENS
  `conformance`/`availability` write) has no defined behavior for partial
  failure — e.g. checkpoint advances but the Sepolia write doesn't land.
  Runs 168x more often than the earlier weekly design, so worth resolving
  early. The SLA path has no equivalent risk since it's never written by
  CRE.
- The "refunded up to" checkpoint on Arc (spec §3) needs testing for missed
  or late runs — does the next run catch up the gap without
  double-refunding?
- ENSv2's Permissioned Registry/Resolver are beta: exact Sepolia addresses,
  ABI stability, and tooling support (viem/ethers/ENS SDK) not yet
  verified. The SLA has no Arc-side fallback, so this needs confirming
  early.
- Identity/SLA layer runs on Sepolia (ENSv2 has no mainnet deployment),
  separate from Arc's own network — a scope decision to state explicitly
  in the submission.
- verdikt.bond domain not yet purchased — price/listing legitimacy
  unverified.
- No dispute layer is a deliberate design choice — state it confidently in
  the submission.

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
[^4]: [ENSIP-5: Text Records](https://docs.ens.domains/ens-improvement-proposals/ensip-5-text-records)
    specifies a text record value as "any arbitrary UTF-8 string," with no
    protocol-level size or content-type constraint — the resolver stores
    and returns it as an opaque string regardless of what's inside it.
[^5]: x402-list.com sells a self-serve verification badge for $0.25/check,
    with its methodology published at x402-list.com/methodology.
