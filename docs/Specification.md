# Verdikt — Specification

Detailed mechanics and technical decisions behind the subsystems introduced
in [Requirements.md](./Requirements.md) §7. Read that document first for
problem, product summary, goals, scope, and user flows.

## 1. SLA verification model

Verdikt evaluates two guarantee categories on one stack, adapting IBM WSLA's
per-guarantee predicate model[^1]:

- **Per-request boolean verdict** — schema/input-output conformance, latency,
  and price-range clauses each evaluate as an independent predicate against the
  provider's declared SLA JSON, per call. Outcome is `PASS`, `FAIL` (a response
  arrived and broke a clause), or `DOWN` (payment settled, no usable response
  came back). Each emits a `VerdictWritten` event on Arc (§3); nothing per-call
  is published beyond Arc.
- **Periodic availability score** — derived from those same verdicts, not a
  separate probe: a service is up unless a paid call reported it down. It is the
  share of settled calls that returned any usable response, mapped through a
  published tier table to the marketplace score (§5), following commercial cloud
  SLA credit banding[^2]. A zero-traffic service scores 1000 — an accepted
  consequence of measuring only what agents paid for; synthesising uptime from
  unpaid probes would measure something other than what consumers buy.

The enum separates the two: conformance measures the quality of responses that
*arrived*; availability, whether they arrived at all. Both recompute **hourly**
over a trailing **7-day** window of `VerdictWritten` events, on a **0–1000
integer scale** (ENS text records are strings; an integer sidesteps
decimal-format ambiguity):

- **Conformance** = `PASS ÷ (PASS + FAIL)`. `DOWN` calls leave the denominator —
  they say nothing about whether the body would have conformed.
- **Availability** = `(PASS + FAIL) ÷ all verdicts`. An empty window yields 1000.

Per-call events are the ground truth on Arc; both ratios are derived,
display-only summaries (§4). One rolling write per service per hour, independent
of call volume; a missed or late run just leaves a stale score until the next
overwrites it, with no refund state to reconcile. Mixing a boolean-per-clause
model with one graduated aggregate follows Rana et al.'s violation-type taxonomy
(all-or-nothing / partial / weighted-partial)[^3]. Rule-based SLA engines[^4]
and ZK/TEE-attested compliance proofs[^5] are cited for reference; Verdikt uses
the WSLA-predicate-plus-tiered-credit stack above.

### A payment the provider refuses

A **402 on the enclave's replay writes no verdict at all**, in either mode. It is
not a delivery failure: the provider is stating it was not paid, so there is no
delivered call to hold it to. Scoring it would be a refund farm — an
authorization that cannot settle (correct `payTo`, empty account) costs an
attacker nothing, and a `FAIL` would credit `min(FIXED_REFUND, paidAmount,
deposit)` out of a bond for a call nobody paid for.

This is what anchors the payer's side of a payment, and it is why the payment
header's signed recipient is **not** compared against the challenge's `payTo`:
a refund can only ever exist on a call the provider accepted payment for, which
is a stronger guarantee than any address comparison the proxy can make — and the
only one available against a provider that mints a single-use payout address per
challenge, where a re-probed challenge never names the address the payer signed.
The narrower challenge-level payTo check was retired for the same reason (#39).

### Fallback when the SLA can't be read

If the `sla` record is unreachable or won't parse, the workflow does not skip
the call — it falls back to status-only: **2xx → PASS, 5xx → `FAIL`, 4xx → no
verdict.** The 4xx carve-out prevents refund-farming: a 4xx is usually the
provider correctly rejecting a malformed request, so scoring it as failure would
let an agent farm refunds with deliberate garbage. Excluding it keeps a
Verdikt-side outage from silently suspending verification without letting the
fallback manufacture refunds out of provider bonds.

## 2. Verification execution — Chainlink CRE Confidential Workflows

Per-request verification runs in a Chainlink CRE Confidential Workflow (TEE):
the enclave replays the agent's x402 payment against the provider (request
credentials kept encrypted in-enclave), evaluates the response against the SLA
(§1), returns the payload for the proxy to relay back, and posts a signed
verdict on Arc (§3) — per
[Chainlink's CRE template pattern](https://docs.chain.link/cre-templates/ai-audit-firewall).

The agent's connection terminates at the proxy, so the response payload transits
it on the way back. What the enclave buys is not that Verdikt never handles those
bytes but that the code reading and judging them is fixed, attested, and
open-source — anyone can check the running enclave's measurement against the
published workflow. Paid API responses often carry proprietary or sensitive data
(market feeds, model outputs, personal data) a provider will not hand a
verification layer on operator trust; attestation is what makes handing it over
acceptable. The proxy relays only — it does not evaluate, retain, or log
response bodies.

Confidentiality of the response body is therefore *not* the claim, and cannot be:
the agent paid for that body, so it must reach the agent, and it transits the
proxy to get there. The claim is that the paid call is executed exactly once and
judged by tamper-proof, published code. Both halves need a TEE, and neither is
about secrecy:

- **Single execution of a pay-once call.** An x402 payment settles exactly once,
  so the enclave's replayed request *is* the call — its response is the only copy
  of what the agent bought. A non-confidential CRE workflow reaches data-trust by
  consensus, with multiple DON nodes each executing the capability call and
  aggregating; pointed at a pay-once POST that settles N times or fails N−1. The
  TEE runs the handler once in a single enclave, with attestation standing in for
  consensus-over-data. This holds even for fully public data — it is why "the
  data isn't secret, so why CRE" does not follow.
- **Tamper-proof judgment.** The verdict auto-refunds from the provider's bond
  with no dispute layer (§3), so it must be produced by code neither the provider,
  Verdikt, nor the agent can bias. The two alternatives each fail one half: a
  plain multi-node DON is trust-minimized but re-executes the paid call; a single
  Verdikt-run server executes once but asks the provider to trust our operator not
  to cook the verdict. Only the TEE delivers both — one paid call, and a verdict
  provably produced by the published workflow.

What confidentiality remains is narrow and worth stating precisely: the body and
the `X-PAYMENT` header stay out of the DON consensus observation and off-chain
(only `outcome`/`payer`/`amount` cross to the DON via `usingTheDons()`), and the
body is seen by one enclave plus the agent it is relayed to, not by every node
operator as a plain workflow would expose it. The residual is that the proxy sees
it in transit — disclosed to providers rather than papered over.

Production CRE enrollment is private-beta; `cre workflow simulate` is self-serve,
and the ETHOnline2026 Chainlink track accepts CLI simulation as sufficient
evidence.

### Proxy request path

The proxy branches on the `X-PAYMENT` header:

- **Absent** — plain passthrough. The provider's response, 402 challenge
  included, is relayed unchanged. The proxy's trust anchor is the service's
  registered `url` (§4, bound to the slug's bond via the ownership check);
  whatever `payTo` that URL's own challenge names is exactly as legitimate as
  the URL itself, so the proxy does not compare it against anything (issue
  #37 — a prior `payTo`-vs-ENS-`address` check was removed as security
  theater: a compromised or malicious upstream can declare whatever `payTo`
  it wants regardless of what is pinned in ENS).
- **Present** — the proxy triggers the confidential workflow and passes the
  header through. The enclave replays it against the provider, evaluates the paid
  response (§1), writes the verdict to Arc (§3), and returns the payload to relay
  back.

The agent signs its own payment, exactly as it would calling the provider
directly; Verdikt holds no wallet on the payment leg and never signs on an
agent's behalf. Payer address and paid amount are both recoverable from the
payment payload, so a refund needs no session state correlating request to
payment — the verdict carries everything the registrar needs.

### Two CRE workflows

The per-request workflow above is confidential (it touches the provider's real
response) and triggers the refund (§3) directly from its `PASS`/`FAIL`/`DOWN`
result.

The hourly reputation run (§1) is a separate CRE workflow on a cron trigger. It
reads only public `VerdictWritten` events, needs no confidentiality, and runs
outside the TEE: it computes the trailing-7-day conformance and availability
ratios and writes both to ENS (§4), making no Arc write and settling no refund.
Confidentiality is an optional, layered CRE feature, and Cron is a first-class
trigger alongside HTTP and on-chain events[^6]. Merging the two would couple the
aggregate to traffic timing (a zero-call hour would never publish) and put
non-confidential logic in the TEE.

## 3. On-chain registry

- **Permissionless registration** — `register(slug)` posts the required deposit.
  `serviceId = keccak256(slug)`, a human-chosen slug reused verbatim as the
  `<slug>.verdikt.bond` route and the `<slug>.verdikt.eth` ENS subname (§4).
  Because one string is three identifiers, the registry validates it as a label
  both DNS and ENS accept (lowercase alphanumeric and hyphen, no leading or
  trailing hyphen, ≤63 bytes), and never lets a deregistered slug be
  re-registered — verdict history is keyed by `serviceId`, so reuse would hand a
  new provider the previous one's record.
- **Deposit/bond** — held in escrow keyed by `serviceId`, in **native USDC**
  (Arc's gas token, so escrow holds value directly — no `approve`/`transferFrom`,
  no token address), a **fixed amount** for MVP. Paid directly to escrow, not
  through the proxy. This is the pool refunds draw from.
- **No SLA on Arc** — the registry struct has no SLA field and no `setSLA`. The
  SLA lives only on the ENS subname (§4); the workflow reads it at run time.
- **One role per service, and it is not an address Verdikt holds** — a CRE
  workflow holds no key and sends no transaction. It ABI-encodes a payload, has
  the DON sign it into a *report*, and the Chainlink KeystoneForwarder calls
  `onReport(metadata, report)` on the registry, which implements `IReceiver`.
  There is no `setVerdict` an EOA can call. The forwarder is shared
  infrastructure, so `msg.sender == forwarder` is not access control on its own:
  the registry also pins the `workflowOwner` carried in the report header, which
  is what restricts verdict-writing to Verdikt's own workflow. Neither provider
  nor Verdikt can write a verdict, and there is no admin able to grant that
  power; the provider's authorship happens on the ENS side (§4). Upstream of the
  chain, the workflow's HTTP trigger is itself signature-gated (a JWT signed by
  a key listed in `authorizedKeys`), so an unauthorised caller cannot even
  produce a report to deliver.
- **Refund, auto-executed, no dispute** — a `FAIL` or `DOWN` on a paid request
  credits a refund from that service's deposit to the payer. The verdict carries
  payer and paid amount out of the payment payload (§2), so the registrar needs
  no correlation table; it records the `requestId`, and a second report against
  the same request writes nothing and pays nothing. Refund and payment are the
  same asset on the same chain (§6) — no cross-chain correlation between the two
  legs. The availability *score* never moves a deposit (§1, §5); a `DOWN`
  refunds because that one call took payment and delivered nothing, not because
  a score crossed a threshold.
- **A declined report is emitted, not reverted** — `onReport` returns nothing
  and the forwarder does not surface a revert usefully, so a report that
  authenticates but has nothing to record (duplicate `requestId`, unknown or
  deregistered service) emits `VerdictRejected` and returns. Reverting would
  make the decline invisible. Authentication failures and malformed reports
  still revert: those are bugs, not outcomes.
- **Pull payments, never push** — `onReport` books `owed[payer] += amount`; the
  agent calls `withdraw()` to collect. Pushing value here would let a payer
  address that rejects transfers revert the whole call and erase its own `FAIL` —
  which a provider farming its own service through a reverting contract could use
  to hold a spotless conformance ratio while failing real calls. Booking a credit
  decouples recording a verdict from paying anyone, and removes the reentrancy
  surface an external call inside the verdict path would open.
- **…and a second pull path, by signature** — the payer recovered from an x402
  payment is reliably *identified* but not reliably *drivable* on Arc: under
  Circle's Gateway it is the agent wallet's backing EOA, and a payer that
  signed on another chain would need Arc USDC before it could claim anything.
  So `withdrawWithAuthorization` recovers the payer from an EIP-712 signature
  instead of trusting `msg.sender`, and anyone may relay it. The recipient and
  the amount are named in that signature, so they are the payer's decision and
  not the relayer's, and a single-use nonce stops the authorization being
  replayed. `withdraw()` remains the cheaper path for a payer that can transact
  on Arc.
- **Refund capped at the amount paid** — `min(fixedRefund, paidAmount)`, never a
  penalty on top. With no dispute layer, a refund larger than the payment would
  make induced failure profitable; capping at the payment makes griefing
  break-even-minus-gas — the griefer recovers only what it spent.
- **Auto-suspend at zero** — when refunds drain a service's deposit to 0, status
  flips to SUSPENDED and the proxy stops routing new payments to it. Topping up
  reinstates it only once the bond is back at the full required deposit: waking
  a service on dust would leave it listed while every refund it then owed was
  capped at that dust, which is the bond meaning nothing.
- **Deregistration** — `deregister(serviceId)`, provider-only; delists and
  returns the remaining deposit. Blocked while SUSPENDED, so a provider can't
  deregister to dodge an outstanding refund obligation.
- **Reading** — `getVerdict`, `getDeposit` view functions on Arc; the SLA
  resolves from the ENS subname directly (§4), no `getSLA` on Arc. A minimal JS
  SDK (or thin REST wrapper) wraps both lookups so callers needn't know multiple
  chains are involved.
- **History** — a `VerdictWritten` event on Arc, replayable off an RPC node with
  no subgraph. SLA edit history is ENS's own `TextChanged` event on the
  Permissioned Resolver (Sepolia); no custom event needed.

## 4. ENS integration — the SLA source of truth

Verdikt targets ENSv2's Permissioned Registry and Resolver. Its Enhanced Access
Control (EAC) scopes write permission per text-record key via
`authorizeTextRoles(name, key, account, grant)`: an address can be granted the
`sla` key only, or the `conformance`/`availability` keys only, with any other
key reverting. ENSv1's PublicResolver has no equivalent — any approved operator
writes any key — so it can't enforce that the provider writes only the SLA and
the CRE verifier writes only the ratios. That per-key ACL is why the SLA lives
only on ENS, never duplicated on Arc (§3): the ENS record *is* the SLA, and the
workflow reads it directly at verification time.

ENSv2 has no mainnet deployment, so this namespace runs on **Sepolia** —
Verdikt's identity/SLA layer is a testnet component alongside Arc's own testnet,
an accepted scope decision for a two-week build.

- Each provider registers a **subname** under `verdikt.eth` (e.g.
  `provider-name.verdikt.eth`), labelled with the same slug as the Arc
  `serviceId` (§3), so `provider-name.verdikt.bond/<path>` — the URL agents
  call — maps directly to `provider-name.verdikt.eth` with no lookup table.
- At mint, EAC roles are set once: the provider's address scoped to the `sla`
  key; the CRE signer scoped to the `conformance` and `availability` keys.
- The subname carries five records:
  - **`url`** — the provider's upstream endpoint, where the proxy relays
    `<slug>.verdikt.bond/*`. Provider-authored and not consensus-significant, so
    it belongs on the side that already has a per-key ACL for provider writes;
    putting it on Arc would cost a chain write per URL change and an Arc read on
    the unpaid leg that is otherwise unnecessary.
  - **`sla`** — written directly by the provider, any time, no Arc involvement;
    the sole copy of the SLA (§3).
  - **`conformance`** and **`availability`** — the two ratios (0–1000, §1),
    written by the CRE signer hourly over the trailing 7-day window (§2, "Two CRE
    workflows"), never per call and never a refund trigger (§3). Per-call
    `PASS`/`FAIL`/`DOWN` verdicts stay Arc-only events (§1).
  - **address** — owner-controlled, set to the provider's payout wallet.
    Surfaced in the marketplace listing; no longer compared against a 402
    challenge's `payTo` (removed, issue #37) — it is not part of the trust
    chain the proxy enforces.
- Because the proxy dials the `url` record from Verdikt's own network, a
  provider-authored URL is a server-side-request-forgery primitive unless it is
  constrained. Private, loopback, link-local and CGNAT hosts are refused before
  any request is made — in both address families and every spelling the URL
  parser normalises (decimal/hex/octal IPv4, IPv4-mapped and compressed IPv6).
  This is a literal-address guard: it does not resolve DNS, so a public name
  that resolves to a private IP is a known residual gap for the demo, not a
  claim this makes.
- The workflow reads the live `sla` record straight from the Permissioned
  Resolver as its verification input, with no IPFS pointer or Arc-side copy to
  drift out of sync.

## 5. Product / dashboard

- **MVP** — a marketplace dashboard (own web UI) listing every registered service
  with its live conformance/availability metrics, deposit balance, and verdict
  history — the surface consumers use to compare similar services and pick one —
  plus aggregate platform stats (services registered, verdict breakdown, refunds
  paid out over time). The primary demo surface.
- **Stretch, in priority order**:
  1. Provider self-serve dashboard (own verdict history, deposit balance,
     SLA-JSON editor).
  2. Machine-facing discovery API — agents filtering the marketplace by
     cost/latency/availability programmatically, on top of the human-facing MVP
     listing.

## 6. Target chain & stack

Two chains, each chosen for what only it provides:

- **Registry / escrow / payment: Arc**, Circle's stablecoin-native L1. The
  registrar, escrow, verdicts, and refunds (§3) all deploy here, and the x402
  call is paid on Arc too. USDC is Arc's native gas token, so payment, bond, and
  refund are one asset on one chain: the agent pays on Arc and, on a `FAIL` or
  `DOWN` verdict, is refunded on Arc from the same-asset bond, with no
  cross-chain correlation between the two legs. x402 settles via **Circle
  Gateway** (batched `GatewayWalletBatched` scheme), which debits a pre-funded
  Gateway balance; the bond is held as native USDC, so a refunded agent receives
  native USDC rather than Gateway credit.
- **Identity / SLA: Ethereum Sepolia** — the only network with an ENSv2
  Permissioned Registry/Resolver deployment, which the SLA and reputation layer
  requires (§4).
- **Verification compute: Chainlink CRE** — a Confidential Workflow (TEE) per
  request, plus a separate plain scheduled workflow for the hourly reputation
  aggregate (§2).
- **SLA storage: none separate** — the SLA is the ENS `sla` text record (§4), an
  arbitrary UTF-8 string per ENSIP-5[^7], not an IPFS-pointed blob. The write is
  infrequent (registration and occasional edits, not per call), so on-chain
  string cost is acceptable and simpler than an IPFS-plus-hash design.
- **Payments: x402**, settled in USDC by the calling agent itself — Verdikt
  relays the handshake and holds no wallet on the payment leg. The demo caller
  uses the Circle Agent Wallet CLI, a ready x402-capable wallet across EVM
  chains.
- **Demo provider** — a [Proceeds](https://myproceeds.xyz) paywall accepting x402
  on Arc Testnet stands in for a live provider. Verdikt requires no provider to
  use Proceeds or settle on Arc — the proxy relays whatever the 402 challenge
  advertises — but settling on Arc is the default that keeps the payment and
  refund legs unified; independently-operated mainnet providers (e.g.
  [Blockrun](https://blockrun.ai/docs/x402/endpoints)) are the production target.

## 7. Architecture

```
Paying agent (signs its own x402 payment; Verdikt holds no payment wallet)
   |
   | 1st call -- no X-PAYMENT header
   v
Verdikt proxy, passthrough branch (ordinary code, outside the enclave)
   - relays the request to the provider, gets the 402 challenge back
   - relays the challenge on unchanged -- the challenge is public, so no
     attestation needed, and the provider's own `url` (bound to the slug's
     bond) is already the trust anchor, so the challenge's payTo is not
     separately checked
   |
   | agent signs the payment, retries with X-PAYMENT
   v
Verdikt proxy, verified branch (relays only -- no evaluation, no
response-body retention or logging)
   |
   | passes the X-PAYMENT header into the workflow
   v
Chainlink CRE Confidential Workflow (TEE) -- per-request run
   - replays the agent's payment against the provider from inside the
     enclave (x402 settles on Arc via Circle Gateway -- §6)
   - resolves provider's live SLA from the ENS Permissioned Resolver
     (Sepolia, verdikt.eth) -- the sole copy, nothing on Arc to drift
   - classifies the paid call -> PASS / FAIL / DOWN (diffs the observed
     response vs SLA, or DOWN when no usable response came back)
   - returns the response payload for the proxy to relay to the agent
   - writes PASS/FAIL/DOWN to Arc as a `VerdictWritten` event carrying the
     payer address and paid amount (refund trigger if FAIL or DOWN) -- Arc only,
     no per-call ENS write
   |
   v
On-chain registry (Arc)
   - verdict events, deposit balance -- no SLA field
   - auto-refund on per-request FAIL or DOWN: min(fixedRefund, paidAmount), paid
     in native USDC from the bond, same chain the call was paid on
   - requestId recorded; a second refund on the same request reverts
   - auto-suspend at zero deposit

Chainlink CRE Workflow (plain, no TEE) -- separate, hourly, trailing 7 days
   - reads VerdictWritten events from the trailing 7-day window on Arc
   - computes conformance ratio + availability ratio (0-1000 each)
   - writes both ratios to the ENS subname (Sepolia) as marketplace scores
   - no Arc write, no refund -- availability never triggers a refund
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

[^1]: IBM's WSLA (Web Service Level Agreement language) ships a reference
    implementation, "SLA Compliance Monitor," in IBM's Web Services
    Toolkit, which evaluates every guarantee as an independent true/false
    predicate and auto-configures itself from a machine-readable SLA spec
    on receipt.
[^2]: E.g. AWS computes a continuous "Monthly Uptime Percentage" over a
    billing window and maps it to a graduated credit table (its EC2
    Region-Level SLA: 99.0–99.99% → 10% credit, 95.0–98.99% → 30%, <95.0% →
    100%) rather than a single cliff.
[^3]: Rana, Warnier, Quillinan, Brazier & Cojocarasu, "Managing Violations
    in Service Level Agreements," *Grid Middleware and Services* (Springer,
    2008). [DOI: 10.1007/978-0-387-78446-5_23](https://doi.org/10.1007/978-0-387-78446-5_23).
[^4]: RBSLA (Rule-Based SLA) — a four-layer rule-engine implementation
    (Prova rule engine, ContractLog KR, RBSLA markup, RBSLM tool) for
    declarative, rule-based SLA compliance.
[^5]: E.g. "Towards Trusted Service Monitoring: Verifiable Service Level
    Agreements" (arXiv:2510.13370, ICSOC 2025), which monitors SLA clauses
    inside TEEs with a zkVM circuit per SLO; and US Patent 12,494,976
    ("Zero-Knowledge Service Level Agreement (SLA) Monitoring," granted
    Dec 2025), which uses non-interactive zero-knowledge proofs.
[^6]: Chainlink's [Confidential Workflows](https://docs.chain.link/cre/concepts/confidential-workflows)
    docs describe confidentiality as an optional, layered feature carved
    out of a standard workflow, not a requirement of every CRE workflow;
    the [Trigger Capability](https://docs.chain.link/cre/capabilities/triggers)
    docs list the Cron trigger as a standard, first-class trigger type
    alongside HTTP and on-chain EVM Log triggers.
[^7]: [ENSIP-5: Text Records](https://docs.ens.domains/ens-improvement-proposals/ensip-5-text-records)
    specifies a text record value as "any arbitrary UTF-8 string," with no
    protocol-level size or content-type constraint — the resolver stores and
    returns it as an opaque string regardless of what's inside it.
