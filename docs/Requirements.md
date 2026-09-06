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

Verification is also hard to bolt on after the fact, for three structural
reasons. First, paid API responses often carry proprietary or sensitive
data — market feeds, model outputs, personal data — and any layer that
checks delivery has to read that data to check it. A verifier whose
operators the provider simply has to take on faith becomes the trust
problem it was meant to solve, so the evaluation has to be auditable:
attested code, published in the open, that anyone can check against what
actually ran. Second, x402 calls are pay-per-request micropayments, often
sub-cent, at a volume no human can audit one response at a time — whatever
checks delivery has to run automatically, per call, not as an occasional
spot-check. Third, the party doing the checking cannot be either party to
the payment. An agent evaluating its own calls and claiming its own refunds
has a standing incentive to report non-compliance; a provider grading itself,
the reverse. With no free public source of truth to re-derive a paid response
against, neither self-report is contestable without an arbitration process.
The evaluation has to be a neutral, deterministic function of (SLA, observed
response) — the same inputs yielding the same verdict for anyone — run by a
party that is neither the provider nor the caller
([spec §3](./Specification.md#3-on-chain-registry)). That is what makes the
reputation judgment-independent.

## 2. Product summary

Verdikt is a marketplace of x402-gated API services that are continuously
monitored and verified, not just self-reported at listing time. Underneath,
a proxy sits between a paying agent and an x402 service, verifies the
response against the provider's own declared SLA inside a Chainlink CRE
Confidential Workflow (TEE), writes a verdict to an on-chain registry, and
auto-refunds the paying agent from the provider's bonded deposit when the
SLA isn't met — with no dispute or arbitration step.

Verification and refund are both code-enforced, so trust in the result does
not depend on either party's judgment, and consumers can pick a service
based on its actual track record instead of a provider's own claims.

## 3. Goals

- Prove that x402 API delivery can be verified automatically, without a
  human-run dispute process, using a provider's own machine-readable SLA.
- Give consumers — human developers and their agents — a list of
  x402-gated services with clear, comparable expectations, so they can
  choose between similar options based on live metrics instead of picking
  at random.
- Demonstrate two distinct, appropriately-matched verdict types in one
  system: a **boolean** per-call verdict for discrete conformance clauses
  that triggers an automatic refund, and a **graduated** score for an
  aggregate/continuous property (availability) that ranks services in the
  marketplace instead.
- Ship a real, live, end-to-end demo (register → verify → refund → query)
  on a public testnet, with a dashboard that visualizes it.
- Fit within a solo 2-week build.

## 4. Non-goals (explicitly out of scope for MVP)

- **Ground-truth fact-checking** — verifying that a response is *factually
  correct* (e.g. re-deriving a claimed exchange rate). Scope is
  conformance/delivery verification only (schema, latency, price,
  availability), not epistemic correctness.
- **Non-REST APIs** — MVP scope is synchronous request/response HTTP APIs
  (REST-style, JSON in/out). Streaming, WebSocket, GraphQL, and gRPC
  endpoints are out of scope; this follows x402's own scope, since the
  protocol's payment flow is itself defined against plain HTTP
  request/response semantics, not an arbitrary cut Verdikt is adding.
- **Dispute/arbitration layer** — no challenge process; a CRE verdict is
  final and auto-executes a refund ([spec §2](./Specification.md#2-verification-execution--chainlink-cre-confidential-workflows)).
- **Weighted multi-clause scoring engine** — no single 0–1 compliance score
  blending every clause; boolean clauses stay boolean, only availability is
  graduated ([spec §1](./Specification.md#1-sla-verification-model)).
- **Reputation-scaled deposit tiers** — deposit is a fixed amount per
  service for MVP.
- **Deposit-via-x402** — the bond is paid directly to the escrow contract,
  not routed through the x402 proxy.
- **Re-derivation/challenge of a CRE verdict** — x402 responses are
  pay-gated, so there is no free, public source of truth a challenger could
  use to re-check a claim. The bond substitutes for re-derivation.
- **Availability-triggered refunds** — the aggregate availability *score*
  never moves a deposit; it only ranks services in the marketplace
  ([spec §3](./Specification.md#3-on-chain-registry)). An individual call
  that settled payment and returned nothing usable is still refunded, but
  as a per-request delivery failure like any other, not because a score
  crossed a threshold.
- **Uptime probing** — availability is derived from paid calls only: a
  service counts as up unless a paid call reported it down, so a service
  with no traffic scores a full 1000. Verdikt measures what agents actually
  bought, not what a synthetic prober would have seen
  ([spec §1](./Specification.md#1-sla-verification-model)).

## 5. Users

1. **API providers** — register an x402-gated service, post a bond, publish
   an SLA. Want a way to prove trustworthiness beyond a self-reported
   listing.
2. **Paying agents** — call registered services, get auto-refunded on
   SLA violations without filing a claim.
3. **Anyone doing due diligence** — a human or agent checking a service's
   live SLA, verdict history, and deposit balance before integrating.

## 6. User flows

- **Service provider**
  1. Register a service: pick a slug, post the required USDC deposit, and
     get a `<slug>.verdikt.bond` endpoint plus a `<slug>.verdikt.eth` ENS
     subname ([spec §3](./Specification.md#3-on-chain-registry),
     [spec §4](./Specification.md#4-ens-integration--the-sla-source-of-truth)).
  2. Publish or update the SLA any time by writing the `sla` ENS text
     record directly — no approval step, no Verdikt backend involved.
  3. Deregister when done, withdrawing the remaining deposit once any
     outstanding refund obligations are settled.
- **Consumer (human or agent)**
  1. Browse the marketplace listing of registered services, each showing
     its live conformance and availability metrics.
  2. Compare similar services on those metrics before choosing one to
     call.
  3. Call the chosen service through Verdikt's HTTP endpoint with any
     x402-capable client, paying exactly as they would against the
     provider directly. Verdikt relays the 402 challenge, checks it,
     verifies the response, and refunds if needed — without the caller
     needing to know multiple chains or a TEE workflow are involved.
  4. View a service's verdict/refund history and deposit balance at any
     time via the dashboard or the view functions directly.

## 7. System overview

Verdikt is four subsystems working together; full mechanics, data flow, and
the architecture diagram live in [Specification.md](./Specification.md).

- **SLA verification** — a per-request boolean verdict for discrete
  conformance clauses (schema, latency, price) that triggers an automatic
  refund, plus a periodic graduated availability score used only for
  marketplace ranking, both evaluated against the provider's own declared
  SLA ([spec §1](./Specification.md#1-sla-verification-model)).
- **Verification execution** — a Chainlink CRE Confidential Workflow (TEE)
  makes the paid call and evaluates the response inside the enclave, so the
  code that reads response content is attested and open source rather than
  taken on trust
  ([spec §2](./Specification.md#2-verification-execution--chainlink-cre-confidential-workflows)).
- **On-chain registry** — a registrar/escrow contract on Arc holds each
  provider's bonded deposit, records verdicts, and auto-executes refunds
  with no dispute step ([spec §3](./Specification.md#3-on-chain-registry)).
  The x402 call itself is also paid on Arc, so payment, bonded deposit, and
  refund all settle on the same chain in the same asset (USDC) — no
  cross-chain correlation between the payment leg and the refund leg
  ([spec §6](./Specification.md#6-target-chain--stack)).
- **ENS integration** — each provider's SLA and derived reputation ratios
  live on an ENSv2 subname (`<slug>.verdikt.eth`), the sole source of truth
  the CRE workflow reads at verification time
  ([spec §4](./Specification.md#4-ens-integration--the-sla-source-of-truth)).
- **Marketplace & dashboard** — a web UI listing registered services with
  their live metrics so consumers can compare and choose, plus aggregate
  platform stats, as the primary demo surface
  ([spec §5](./Specification.md#5-product--dashboard)).

## 8. Competitive landscape

- **x402-list.com** — closest existing competitor. Tracks 600+ x402
  services via uptime probing and a protocol-compliance checklist
  (structural, not claim verification), and already sells a paid
  verification badge[^4] — evidence that willingness-to-pay for
  verification exists today. No confidential-compute angle; Verdikt's
  differentiator is verifying actual response content against a
  provider-declared SLA, privately, not just probing uptime.
- **x402disputes.com** and **x402r.org** — both address x402 refunds, but
  via manual dispute/arbitration: a party files a dispute with evidence
  (x402disputes.com) or an escrow with a pluggable arbiter resolves a claim
  (x402r.org). Verdikt never invokes a human or third-party arbiter — the
  verdict is a deterministic, automatic function of the SLA and the
  observed response ([spec §1](./Specification.md#1-sla-verification-model)).
- **Edge & Node's ampersend** — an agent-payment dashboard on x402 + A2A +
  ERC-8004 covering budget limits and allowlists; a human-configured
  spend-management tool, not an automated verification/reputation proxy.
- **Circle's [agent marketplace](https://agents.circle.com/sell)** — lets
  providers list x402 endpoints and scores an endpoint's "agent-readiness"
  before listing: a check that an endpoint is structurally ready to be listed,
  not that a listed endpoint keeps delivering what it promised once it's live
  and paid per call. Verdikt is the piece downstream of listing — ongoing,
  automatic verification of delivery against a provider's own SLA, with
  code-enforced refunds when it falls short.

## 9. Open risks / unresolved

- Payment settlement uses Circle Gateway's batched scheme
  (`GatewayWalletBatched`), which requires the caller to pre-fund a Gateway
  balance (a `direct` on-chain deposit into the Gateway wallet) rather than
  paying from the wallet's plain token balance. The escrow contract's refund
  side is not yet wired to the payment leg: a FAIL or DOWN verdict must credit the
  paying agent on Arc from the bond, and that registrar→refund path still
  needs building and testing.
- **Induced-failure griefing.** With no dispute layer, an agent can craft
  requests designed to push a service into violating its own SLA — a query
  hitting a slow path, or one that trips a schema edge case — and collect a
  refund each time until the bond drains and the service auto-suspends.
  Capping the refund at the amount actually paid makes the attack
  break-even-minus-gas rather than profitable
  ([spec §3](./Specification.md#3-on-chain-registry)); any refund larger
  than the payment turns griefing into a strategy, with no arbitration to
  fall back on.
- The trust argument rests on attestation — that the enclave is running
  the published workflow code. Production CRE enrollment is private-beta, so
  the demo can only simulate that, and the submission should say so rather
  than implying a live attested deployment.
- Availability tier boundaries/percentages may need tuning during build.
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
[^4]: x402-list.com sells a self-serve verification badge for $0.25/check,
    with its methodology published at x402-list.com/methodology.
