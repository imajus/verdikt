# Verdikt — Specification

Detailed mechanics and technical decisions behind the subsystems introduced
in [Requirements.md](./Requirements.md) §7. Read that document first for
problem, product summary, goals, scope, and user flows.

## 1. SLA verification model

Verdikt verifies two categories of guarantee using one evaluation stack,
adapted from IBM's WSLA per-guarantee predicate model[^1]:

- **Per-request boolean verdict (PASS/FAIL)** — schema/input-output
  conformance, latency, and price range are each evaluated as an
  independent true/false predicate against the provider's declared SLA
  JSON, per call. Each result emits a `VerdictWritten` event on Arc (§3);
  nothing per-call is published beyond Arc.
- **Periodic availability score** — computed as a continuous uptime
  percentage (100% minus percentage downtime) over a trailing window, then
  mapped through a published tier table to a score shown in the marketplace
  listing (§5), following the same tiered-banding approach used in
  commercial cloud SLA credit tables[^2]. Availability never triggers a
  refund (§3): if a service was down, it couldn't have collected payment
  for that window either, so there is nothing to refund — the score exists
  purely to help consumers rank services.

Both scores recompute **hourly** from a rolling trailing **7-day** window of
`VerdictWritten` events:
- **SLA conformance ratio** — PASS count ÷ total calls in the trailing
  7 days, expressed on a **0–1000 scale** (e.g. 987 = 98.7% conformance)
  rather than a percentage (ENS text records are strings; an integer avoids
  decimal-formatting ambiguity).
- **Availability ratio** — the same 0–1000 scale applied to the uptime
  percentage above.

An hourly rolling-window write costs at most one ENS update per service per
hour, regardless of call volume, and is fresher than a weekly one while
still reflecting a week of history. Per-call events remain the ground truth
on Arc; both ratios are derived, display-only summaries (§4) — a missed or
late hourly run just leaves a stale score until the next run overwrites it,
with no refund state to reconcile.

Both mechanisms share one evaluation engine and one SLA schema. Mixing a
boolean-per-clause model with one graduated aggregate metric follows Rana
et al.'s taxonomy of SLA violation types (all-or-nothing / partial /
weighted-partial)[^3].

Other approaches exist — rule-based SLA engines[^4], zero-knowledge/
TEE-attested compliance proofs[^5] — cited for reference; Verdikt uses the
WSLA-predicate plus tiered-credit stack above.

### Why a neutral middleman, not caller-side evaluation

An alternative design would let the paying agent evaluate compliance itself
and decide whether to claim a refund. This is simpler to build but
structurally weak: the agent has a direct financial incentive to claim
non-compliance regardless of the actual response, the provider has no way
to contest a false claim without an arbitration process, and neither
party's evaluation is auditable by anyone else.

Verdikt instead runs the compliance check inside a neutral, deterministic
middleman. The same SLA JSON evaluated against the same observed response
produces the same verdict regardless of who is asking; the verifier role is
code-enforced and held by neither the provider nor the calling agent (§3);
and the resulting verdict is written on-chain, so any third party can trust
it without having to trust the agent or the provider individually. This is
what makes the reputation system judgment-independent: compliance is a
deterministic function of (SLA, response), evaluated once by an unbiased
third party.

## 2. Verification execution — Chainlink CRE Confidential Workflows

Verification runs inside a Chainlink CRE Confidential Workflow (TEE); the
workflow itself makes the outbound HTTP call to the provider's API, so
Verdikt's own proxy/backend never receives or terminates the provider's
response. If Verdikt's infrastructure fetched the response first, it would
already be exposed before the enclave got it — confidentiality has to be
enforced at the point of fetch.

API responses often contain proprietary or otherwise valuable data — market
data feeds, proprietary model outputs, personal data — that a provider has
a legitimate interest in keeping confidential even from the verification
layer. Because the enclave fetches directly, Verdikt never sees response
content, only the derived verdict.

The enclave fetches the provider's response directly (request credentials
kept encrypted in-enclave), evaluates the checks in §1, releases the
response to the calling agent, and posts a signed verdict on-chain — per
[Chainlink's CRE template pattern](https://docs.chain.link/cre-templates/ai-audit-firewall).
Verdikt's backend is a thin coordinator: it handles the x402 handshake
(relaying the 402 challenge, correlating payment to request) and triggers
the workflow run, without ever decrypting or logging a provider response
body. The handshake and the USDC payment settle on **Arc** — the same chain
the verdict and refund land on (§3) — so payment and refund share one chain
and one asset. The demo provider is a [Proceeds](https://myproceeds.xyz)
paywall wrapping a real upstream API (Open-Meteo) and accepting x402 on Arc
Testnet; payment settles via **Circle Gateway** (the batched
`GatewayWalletBatched` scheme), proven end-to-end on Arc Testnet — a paid
call returned the provider's real JSON with a `success` receipt on
`eip155:5042002`. Verdikt does not require providers to use Proceeds; the
proxy relays whatever chain and scheme the provider's 402 challenge
advertises, but settling on Arc is the default that keeps the payment and
refund legs unified.

Production CRE enrollment is currently private-beta; `cre workflow
simulate` is self-serve, and the ETHOnline2026 Chainlink track accepts CLI
simulation as sufficient evidence.

### Two CRE workflows

The workflow above is per-request: proxy-triggered right after payment
settles, confidential because it touches the provider's actual response. It
also triggers the per-request refund (§3) directly from its own PASS/FAIL
result.

The hourly reputation-scoring run (§1) is a separate CRE workflow on a
cron trigger. It only reads `VerdictWritten` events already public on Arc,
so it needs no confidentiality and doesn't run in the TEE: it computes the
trailing-7-day conformance and availability ratios and writes both to ENS
as marketplace scores — it makes no Arc writes and settles no refund.
Confidentiality is an optional, layered feature of a CRE workflow, and Cron
is a first-class trigger type alongside HTTP and on-chain events[^6].

Merging the two would make the aggregate depend on traffic timing (an hour
with zero calls would never publish) and put non-confidential logic inside
the TEE workflow — kept separate instead.

## 3. On-chain registry

- **Permissionless registration**: `register(serviceId)` on a registrar
  contract, posting the required deposit. `serviceId` = `keccak256` of a
  human-chosen slug. The same slug doubles as the `<slug>.verdikt.bond`
  routing subdomain and the `<slug>.verdikt.eth` ENS subname label (§4) —
  one identifier, reused across all three surfaces.
- **Deposit/bond**: held in an escrow contract keyed by `serviceId`, paid in
  USDC, **fixed amount** for MVP (no reputation-scaled tiering). This is the
  pool refunds are paid from. Paid directly to escrow, not through the
  proxy.
- **No SLA storage on Arc**: the registry struct has no SLA field and no
  `setSLA` function. The SLA lives only on the provider's ENS subname
  (§4); the verification workflow reads it from ENS at run time, diffing
  against whatever the provider published there.
- **One role per service**: verifier only (the CRE workflow's callback
  signer, can `setVerdict`). Neither the provider nor Verdikt itself can
  write a verdict — enforced at the contract level. The provider has no
  write role on Arc — their authorship happens on the ENS side (§4).
- **Refund, auto-executed, no dispute step**: a FAIL verdict for a specific
  paid request releases a fixed refund from that service's deposit to the
  paying agent automatically (the proxy already correlates
  request↔payment↔verdict). This is the only refund trigger — availability
  is scored (§1, §5) but never refunded: if the service was down, it
  couldn't have collected payment for that window in the first place, so
  there's nothing to refund. The refund is paid on Arc from the bonded
  deposit, in the same asset (USDC) and on the same chain the x402 call was
  paid on (§2) — payment and refund share one chain, so there is no
  cross-chain correlation between the leg the agent paid on and the leg it is
  refunded on.
- **Auto-suspend at zero**: once refunds drain a service's deposit to 0,
  the registrar flips status to SUSPENDED and the proxy stops routing new
  payments to it until topped up.
- **Deregistration**: `deregister(serviceId)`, provider-only, delists the
  service from the marketplace and withdraws the remaining deposit. Blocked
  while status is SUSPENDED, so a provider can't deregister to dodge an
  outstanding refund obligation.
- **Reading**: any agent or dApp checks a service's verdict/deposit via view
  functions (`getVerdict`, `getDeposit`) on Arc, and its SLA by resolving
  the ENS subname directly (§4) — no `getSLA` on Arc. A minimal JS SDK
  (or thin REST wrapper) should ship alongside the contract to wrap both
  lookups so callers don't need to know multiple chains are involved.
- **History**: a standard `VerdictWritten` event on Arc for verdict history,
  replayable directly off an RPC node with no subgraph dependency. SLA edit
  history is covered by ENS's own `TextChanged` event on the Permissioned
  Resolver (Sepolia); no custom event needed.

## 4. ENS integration — the SLA source of truth

Verdikt targets ENSv2's Permissioned Registry and Permissioned Resolver,
not ENSv1. ENSv2's Enhanced Access Control (EAC) scopes write permission to
a single text-record key via `authorizeTextRoles(name, key, account,
grant)`: an address can be granted rights to write only the `sla` key, or
only the `conformance`/`availability` keys, with any other key reverting.
ENSv1's PublicResolver has no equivalent — any approved operator can write
any text key — so it can't enforce that the provider writes only the SLA
and the CRE verifier writes only the reputation ratios.

That per-key ACL is why the SLA lives only on ENS, not duplicated on Arc
(§3) — the ENS record is the SLA, and the CRE workflow reads it directly
at verification time.

Trade-off: ENSv2 has no mainnet deployment, so this namespace runs on
**Sepolia** — Verdikt's identity/SLA layer is a testnet component alongside
Arc's own testnet, not a `verdikt.eth` mainnet name. An accepted scope
decision for a two-week build.

- Each API provider registers a **subname** under `verdikt.eth` on the
  ENSv2 Permissioned Registry (Sepolia), e.g. `provider-name.verdikt.eth`.
  The label is the same human-chosen slug used for the on-chain `serviceId`
  (§3), so `provider-name.verdikt.bond/<path>` — the URL agents actually
  call — maps directly to `provider-name.verdikt.eth` with no separate
  lookup table.
- At mint time, the resolver's EAC roles are set: the provider's address
  gets a role scoped to the `sla` key only; the CRE workflow's signer
  address gets a role scoped to the `conformance` and `availability` keys
  only, granted once at registration.
- The subname carries four records:
  - An **`sla` text record**, written directly by the provider, any time,
    with no Arc involvement — the sole copy of the SLA (§3).
  - A **`conformance` text record** — the SLA conformance ratio (0–1000,
    §1), and an **`availability` text record** — the availability ratio
    (0–1000, §1), both written by the CRE workflow's signer hourly over
    the trailing 7-day window (§1), not per call — the same scheduled run
    described in §2's "Two CRE workflows". Neither record ever triggers a
    refund (§3); per-call PASS/FAIL verdicts stay Arc-only events (§1) and
    never touch ENS individually.
  - An **address record**, owner-controlled, set to the provider's
    payout wallet.
- At payment time, the CRE workflow resolves the subname's address record
  and compares it against the `payTo` address in the live x402 402
  response. A mismatch blocks payment before it is sent — checked
  pre-payment, not post-hoc like §1's checks, since a spoofed payTo
  address leaves no bonded deposit to reclaim funds from.
- The CRE workflow reads the live `sla` text record straight from the
  Permissioned Resolver (Sepolia) as its verification input, with no IPFS
  pointer or Arc-side copy to drift out of sync.

## 5. Product / dashboard

- **MVP**: a marketplace dashboard (own web UI) listing every registered
  service with its live conformance/availability metrics, deposit balance,
  and verdict history — the surface consumers use to compare similar
  services and pick one, plus aggregate platform stats (services
  registered, verdict breakdown, refunds paid out over time). The primary
  demo surface.
- **Stretch, in priority order**:
  1. Provider self-serve dashboard (own verdict history, deposit balance,
     SLA-JSON editor).
  2. Machine-facing discovery API — agents filtering the marketplace by
     cost/latency/availability programmatically, on top of the human-facing
     MVP listing.

## 6. Architecture

```
Paying agent
   |
   v
Verdikt proxy (thin coordinator — handshake + payment/request
correlation only; never decrypts or logs a provider response)
   |
   | relays 402 challenge; checks verdikt.eth payTo record before
   | payment; x402 payment settles on Arc via Circle Gateway
   | (Proceeds paywall wrapping Open-Meteo as the demo provider);
   | triggers a workflow run
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
   - auto-refund on per-request FAIL (paid on Arc from the bond, same
     chain and asset the call was paid on -- both legs USDC on Arc)
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
