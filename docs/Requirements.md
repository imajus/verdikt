# Verdikt — Project Requirements Document

**Domain**: verdikt.bond (pending purchase)
**Event**: ETHOnline 2026, solo build, 2-week window (started Sep 2, 2026)
**Status**: MVP scope locked Sep 6, 2026. Not yet built.

---

## 1. Problem

x402 (HTTP-native pay-per-call payments) has no verification layer. The
Facilitator settles payment; the Bazaar directory is self-reported discovery.
Neither checks that a paid-for API call actually delivered what the provider
advertised. A USENIX Security '26 study of 15 major x402 facilitators
(covering ~99% of observed volume, including Coinbase) found **all 15**
violated at least one security rule across 31 distinct vulnerabilities — live
evidence that "payment settled ≠ service delivered correctly" is a real,
current gap, not a hypothetical.

ERC-8004 ("Trustless Agents") already defines an Identity/Reputation/
Validation registry pattern for agents, and its own spec text admits it
"cannot cryptographically guarantee that advertised capabilities are
functional and non-malicious." As of a May 2026 study, **zero confirmed
mainnet deployments** of its Validation Registry exist. The standard exists;
nobody has built the missing piece.

## 2. Product summary

Verdikt is an automated, judgment-independent reputation and refund system
for x402-gated APIs. A proxy sits between a paying agent and an x402 service,
verifies the response against the provider's own declared SLA inside a
Chainlink CRE Confidential Workflow (TEE), writes a verdict to an on-chain
registry, and auto-refunds the paying agent from the provider's bonded
deposit when the SLA isn't met — with no dispute or arbitration step.

Denis's framing: a reputation system "not dependent on the agent's
judgement." Verification and refund are both code-enforced.

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
- **Dispute/arbitration layer** — no Kleros-style challenge process. A CRE
  verdict is final and auto-executes a refund; this is a deliberate
  design choice (see §6.4), not a shortcut.
- **Weighted multi-clause scoring engine** — no single 0–1 compliance score
  blending every clause. Boolean clauses stay boolean; only availability is
  graduated (see §6.1 for the precedent justifying this split).
- **Reputation-scaled deposit tiers** — deposit is a fixed amount per
  service for MVP.
- **Deposit-via-x402** — the bond is paid directly to the escrow contract,
  not routed through the x402 proxy.
- **Re-derivation/challenge of a CRE verdict** — unlike comparable ENS-track
  projects (Immunity, Assay) that let a challenger re-check a claim for
  free via on-chain state, x402 responses are pay-gated; there's no free
  source to fund a re-check. The bond substitutes for re-derivation.

## 5. Users

1. **API providers** — register an x402-gated service, post a bond, publish
   an SLA. Want a way to prove trustworthiness beyond a self-reported
   listing (validated by x402-list.com's existing paid "verified badge"
   product — proof that providers already pay for this).
2. **Paying agents** — call registered services, get auto-refunded on
   SLA violations without filing a claim.
3. **Anyone doing due diligence** — a human or agent checking a service's
   live SLA, verdict history, and deposit balance before integrating.

## 6. Functional requirements

### 6.1 SLA verification model

Two verdict types, decided after a research pass into SLA-verification prior
art (WSLA, RBSLA, AWS SLA credits, an ICSOC 2025 TEE+zkVM paper, an Ericsson
ZK-SLA patent, and Rana et al.'s 2008 SLA-violation taxonomy):

- **Per-request boolean verdict (ALLOW/DENY)** — schema/input-output
  conformance, latency, and price range, evaluated per call against the
  provider's SLA JSON. Same per-guarantee true/false predicate model as
  IBM's WSLA (a real, deployed SLA-monitoring framework — "SLA Compliance
  Monitor," shipped in IBM's Web Services Toolkit), not an invented
  shortcut.
- **Periodic availability score** — a continuous, AWS-Monthly-Uptime-
  Percentage-style metric (100% − % downtime) computed over a rolling
  window, mapped through a small published tier table (mirrors AWS's own
  graduated Region-Level SLA credit bands, e.g. 99.0–99.99%→10% credit,
  95.0–98.99%→30%, <95.0%→100%) to a refund percentage, rather than a
  second boolean.
- Justification for mixing verdict types in one agreement: Rana, Warnier,
  Quillinan, Brazier & Cojocarasu, "Managing Violations in Service Level
  Agreements" (Springer, 2008, DOI 10.1007/978-0-387-78446-5_23) formally
  classifies violations into all-or-nothing / partial / weighted-partial
  *within the same agreement* — directly supports boolean-for-discrete-
  clauses + graduated-for-aggregate rather than one scoring model for
  everything.

### 6.2 Verification execution — Chainlink CRE Confidential Workflows

- CRE (TEE) runs the actual diff between observed response and the
  provider's SLA JSON, so raw request/response payloads never leave the
  enclave — only the non-sensitive verdict crosses back out.
- Modeled on Chainlink's own reference template, "AI Audit Firewall"
  (docs.chain.link/cre-templates/ai-audit-firewall): fetch external data
  with in-enclave credentials, run independent checks, merge via simple
  logic, post a signed verdict on-chain.
- Production CRE enrollment is private-beta; `cre workflow simulate` is
  self-serve and the ETHOnline2026 Chainlink track explicitly accepts CLI
  simulation as sufficient evidence — not a hackathon blocker.

### 6.3 On-chain registry (custom contract, not ENS — see §9)

- **Permissionless registration**: `register(serviceId)` on a registrar
  contract, posting the required deposit. `serviceId` = `keccak256` of a
  human-chosen slug.
- **Deposit/bond**: held in an escrow contract keyed by `serviceId`, paid in
  USDC, **fixed amount** for MVP (no reputation-scaled tiering). This is the
  pool refunds are paid from. Paid directly to escrow, not through the
  proxy.
- **SLA record**: provider writes one JSON blob (schema, max latency, min
  availability, cost, refund policy) to IPFS, pointed to by a string field
  on the registry struct. Mutable any time by the owner. This is what makes
  CRE's verification logic generic — it diffs against whatever the provider
  committed to, not a hardcoded per-service check.
- **Two roles per service**: owner (can `setSLA`) and verifier (the CRE
  workflow's callback signer, can `setVerdict`). Neither the provider nor
  Verdikt itself can write a verdict — enforced at the contract level, not
  by convention. This is what makes "independent reputation" literally
  true.
- **Two refund paths, both auto-executed, no dispute step**:
  1. *Per-request*: a DENY verdict for a specific paid request releases a
     fixed refund from that service's deposit to the paying agent
     automatically (proxy already correlates request↔payment↔verdict).
  2. *Periodic availability*: at each monitoring window's end, if computed
     uptime falls below the SLA's advertised availability, a refund
     percentage from the tier table (§6.1) is distributed pro-rata from
     the deposit to everyone who paid during that window.
- **Auto-suspend at zero**: once refunds drain a service's deposit to 0,
  the registrar flips status to SUSPENDED and the proxy stops routing new
  payments to it until topped up — no governance step.
- **Reading**: any agent or dApp checks a service's SLA/reputation via view
  functions (`getSLA`, `getVerdict`, `getDeposit`). A minimal JS SDK (or
  thin REST wrapper) should ship alongside the contract so integration cost
  stays low without ENS-style free resolution.
- **History**: standard events (`SLAUpdated`, `VerdictWritten`) on every
  write — verdict history is replayable directly off an RPC node, no
  subgraph dependency.

### 6.4 ENS payout-address integrity check (stretch goal)

Reuses `api.eth` (registered by Denis on Sepolia). Distinct from, and not a
reversal of, the decision to keep ENS out of the core registry.

- Provider publishes its payout address as an ENS record on its own name.
- At payment time, CRE resolves that record and compares it against the
  `payTo` address in the live x402 402 response.
- Match → proceed. Mismatch → **block payment outright** — this must be a
  pre-payment gate, not a post-hoc verdict like §6.1's checks, because once
  an agent pays a spoofed address there is no deposit to reclaim it from.
- Build the core (6.1–6.3) first; attempt this only if time remains.

### 6.5 Product / dashboard

- **MVP**: a platform dashboard (own web UI) showing aggregate stats —
  services registered, verdict breakdown (ALLOW/DENY), deposits held,
  refunds paid out over time. This is the primary demo surface, not just
  backend contracts.
- **Stretch, in priority order**:
  1. Provider self-serve dashboard (own verdict history, deposit balance,
     SLA-JSON editor).
  2. Discovery UI/API — human browse/search + machine-facing discovery API
     for agents filtering by cost/latency/availability.

## 7. Architecture summary

```
Paying agent
   |
   v
Verdikt proxy  <--- intercepts x402 request/response
   |
   v
Chainlink CRE Confidential Workflow (TEE)
   - resolves provider's SLA JSON (IPFS)
   - diffs observed response vs SLA
   - [stretch] resolves ENS payout address, compares vs payTo
   - emits signed verdict (ALLOW/DENY + availability score)
   |
   v
On-chain registry (Arc)
   - SLA record, verdict, deposit balance, roles
   - auto-refund on DENY / low availability
   - auto-suspend at zero deposit
   |
   v
Dashboard — reads registry via SDK/view functions
```

## 8. Target chain & stack

- **Chain**: Arc (Circle's stablecoin-native L1), decided Sep 5 — replaced
  Hedera same day. Reasons: Arc already has a live x402 services
  marketplace (natural place for the proxy to sit and rate existing
  listings); plain EVM L1 (no chain-specific primitives to learn under time
  pressure); an x402-capable wallet CLI already exists for Arc; **Blockrun**
  (blockrun.ai) already runs an x402-gated API on Arc — a real candidate
  demo target to wrap rather than standing up a bespoke API; USDC-native
  settlement matches the fixed-USDC deposit design.
- **Verification compute**: Chainlink CRE Confidential Workflows.
- **Storage**: IPFS for SLA JSON blobs.
- **Payments**: x402, settled in USDC.

## 9. Prize track fit

Submission constraint: max 3 Partner Prizes selectable (a partner's
multiple tracks count as one slot).

- **Chainlink** — confirmed core (CRE is the verification engine itself).
- **Arc** — confirmed core (chain + demo API target).
- **Open** — 1 slot unfilled. ENS is a candidate for this slot *only if*
  the §6.4 stretch goal ships; otherwise leave open or fill with whatever
  else fits by submission time.
- **Explicitly excluded**: The Graph (no match), Ledger (no device-spend
  action to gate — fits Concept A instead), Bazantic (its facilitator
  doesn't support Arc).
- **ENS as a core pillar** — dropped Sep 4: the original design never
  resolved a name to an address, and the two-role write-separation pattern
  isn't ENS-specific (a generic access-control pattern), so a bespoke
  contract avoids ENSv2 Sepolia-beta limitations without losing anything
  load-bearing.

## 10. Competitive landscape

- **x402-list.com** — closest existing competitor. Tracks 631+ x402
  services via uptime probing + a 14-point protocol-compliance checklist
  (structural, not claim verification). Already sells a paid verification
  badge ($0.25/check) — proof that willingness-to-pay for verification
  exists today. No TEE/confidential-compute angle — Verdikt's differentiator.
- **Settld** — live competitor with near-identical framing ("no way to
  prove the work was actually done before the money moves"). Flagged for
  direct evaluation before submission.
- **Edge & Node's ampersend** — agent-payment dashboard on x402 + A2A +
  ERC-8004; human-configured budget/allowlist tool, not an automated
  verification/reputation proxy.
- Past ETHGlobal ENS-track winners worth knowing (Immunity, Assay, DeFacts
  AI) validate the bonding/escrow/role-separated-verdict pattern generally,
  even though Verdikt no longer builds the registry on ENS itself.

## 11. Demo script

1. Provider registers a service on the registry, posts a deposit, points
   to its SLA JSON.
2. A live x402 call runs through the Verdikt proxy against that SLA, inside
   the CRE enclave.
3. CRE's signer writes the verdict on-chain (only that signer has write
   access).
4. On a DENY, the paying agent is auto-refunded from the deposit — no
   dispute step.
5. A second agent queries the registry for the same service and sees a
   live SLA, verdict, and deposit balance it can trust without trusting
   Verdikt or the provider.
6. Dashboard shows the aggregate view: verdicts issued, refunds paid,
   deposits held, live availability score with tier-based refund pool.

## 12. Build phases (solo, remainder of 2-week window)

Exact calendar dates not fixed here — sequence by dependency, not by day:

1. **Foundation**: registrar + escrow contract (register, deposit, SLA
   pointer, two-role access control, events) on Arc testnet.
2. **Verification core**: CRE workflow — fetch SLA JSON, diff against a
   real Blockrun (or equivalent) x402 response, emit boolean verdict,
   signer writes to registry.
3. **Refund paths**: per-request DENY refund; periodic availability
   computation + tiered pro-rata refund; auto-suspend at zero deposit.
4. **Proxy**: sits in the request path, correlates request↔payment↔verdict,
   forwards to the demo API.
5. **Dashboard**: aggregate stats view (MVP demo surface).
6. **Stretch, only if time remains**: ENS payout-address integrity check
   (§6.4); provider self-serve dashboard; discovery UI/API.
7. **Submission prep**: write up explicit known gaps (reads as credibility
   in this judging pool, not weakness, per past ENS-track winner patterns);
   confirm Chainlink CLI-simulation evidence is sufficient in lieu of
   private-beta CRE production access; finalize prize-track selections.

## 13. Open risks / unresolved

- Settld not yet evaluated directly as a competitor.
- Blockrun's x402 integration and response schema not yet confirmed as a
  good verification target — may need a thinner/different demo API.
- x402-capable wallet CLI for Arc referenced but not yet named/tested.
- Availability tier boundaries/percentages may need tuning during build.
- verdikt.bond domain not yet purchased — price/listing legitimacy unverified.
- No dispute layer is a deliberate design choice, but should be stated
  explicitly and confidently in the submission, not hedged.
