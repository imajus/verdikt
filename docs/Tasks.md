# Verdikt — Development plan

Step-by-step build plan for the system specified in
[Requirements.md](./Requirements.md) and [Specification.md](./Specification.md).
Two weeks, solo.

Phases are ordered by **risk, not by layer**. The three unknowns in
Requirements §9 gate everything downstream, so they get spiked before any
real code is written; each carries an explicit fallback and a date by which
the fallback must be taken.

## Phase 0 — Scaffold and de-risk (days 1–2)

Nothing in Phases 1–5 is safe to build until 0.2–0.4 have answers.

### 0.1 Repo scaffold

- [ ] pnpm workspace:
  - `contracts/` — Foundry (Solidity)
  - `packages/sla/` — evaluation engine (JS, ESM)
  - `packages/sdk/` — Arc + ENS read wrapper (spec §3)
  - `cre/` — the two workflows
  - `proxy/` — Fastify
  - `web/` — dashboard
  - `fixtures/` — recorded challenges, payloads, responses
- [ ] Vitest at the root; JS + ESM throughout except where the CRE SDK
      forces otherwise (see 0.3)
- [ ] `.env.example` with Arc Testnet RPC, Sepolia RPC, contract addresses
- [ ] CI: lint + `vitest run` + `forge test` on push

### 0.2 Spike A — ENSv2 on Sepolia (highest risk)

The SLA has no Arc-side fallback, so if this layer doesn't work there is no
source of truth to verify against.

- [x] Find the deployed Permissioned Registry / Permissioned Resolver
      addresses on Sepolia
- [x] Mint a subname under a parent name we control
- [x] Write an `sla` text record; read it back byte-identical
- [x] Exercise `authorizeTextRoles(name, key, account, grant)`
- [x] Assert the negative case: an address scoped to `sla` **reverts** when
      writing `conformance`. Per-key ACL is the entire reason for choosing
      ENSv2 over v1 (spec §4) — if it doesn't enforce, the justification is
      gone
- [x] Determine tooling: does viem/ethers/the ENS SDK support these, or are
      raw ABI calls needed?

Deliverable: `scripts/spike-ens.mjs` running all of the above green.

> **Gate passed.** 31/31 green — `pnpm spike:ens`, run against `verdikt.eth`
> itself. Per-key EAC enforces, `sla` round-trips byte-identical, and
> `UniversalResolverV2` serves all four records by name. ENSv2 stays; the
> ENSv1 PublicResolver fallback is not taken. Findings, the confirmed Sepolia
> addresses, and the two ACL-bypass routes the role bitmap has to close are in
> [spikes/A-ens-sepolia.md](./spikes/A-ens-sepolia.md).
>
> Two things the spike surfaced, both now done on Sepolia via
> `pnpm setup:ens` (`scripts/setup-ens.mjs`): `verdikt.eth` had no subregistry,
> so no `<slug>.verdikt.eth` could exist at all; and the resolver's
> `ROOT_RESOURCE` roles do not move when the name is transferred, so they had
> to be pointed at the operator deliberately. Addresses are in `.env.example`
> and the spike doc. Re-running the script against a namespace already set up
> reports nothing to do.

### 0.3 Spike B — Chainlink CRE

- [ ] `cre workflow simulate` on a hello-world
- [ ] Confirm an HTTP trigger, an outbound HTTP call from inside the
      workflow, and an EVM write
- [ ] Confirm an **Arc chain selector exists** for the EVM write capability
- [ ] Confirm confidential mode simulates
- [ ] **Decide the workflow language.** The CRE SDK is Go or TypeScript. TS
      lets `packages/sla` be imported directly; Go means the evaluation
      engine is written twice and the two copies can drift — which for a
      final, undisputable verdict is a correctness risk, not just
      duplication. Strong preference for TS

Deliverable: `cre/spike/` green under `simulate`.

> **Gate — day 3.** No Arc chain selector → verdict writes need a relay
> path (workflow signs, proxy or a keeper submits). Decide before Phase 3.

### 0.4 Spike C — `X-PAYMENT` decoding

Every refund depends on recovering the payer and the amount from the header.

- [ ] Capture a real `GatewayWalletBatched` `X-PAYMENT` header from a live
      paid call on Arc Testnet
- [ ] Decode it; extract payer address and paid amount
- [ ] **Verify those fields are cryptographically bound** — signed by the
      payer, not merely asserted in a JSON blob. The refund target is read
      out of this header, so if the binding is weak, anyone can name a
      different payer and redirect refunds
- [ ] Confirm the amount is in known minor units (needed for the refund cap
      and for the price clause)

Deliverable: `packages/sdk/payment.js` with `decodePayment(header)` plus a
fixture test.

> **Fallback.** If payer/amount aren't verifiable from the header alone,
> take them from the settlement receipt instead and have the enclave
> confirm settlement before writing a verdict.

### 0.5 Freeze fixtures

- [ ] Record and commit: 402 challenge JSON, `X-PAYMENT` header, provider
      200 response, settlement receipt
- [ ] Everything downstream develops against these — no live paid call
      needed to run a test

### 0.6 Domain

- [ ] Buy `verdikt.bond`, or pick a fallback subdomain on an owned domain
      and update the docs
- [x] **ENS parent name.** `verdikt.eth` is registered on Sepolia ENSv2
      (expires 2027-09-06) with a `PermissionedResolver` attached, so
      `ENS_PARENT_NAME` stands as-is. Its subregistry is not deployed yet —
      that is onboarding work, not a naming decision

---

## Phase 1 — SLA schema and evaluation engine (days 2–3)

The core IP, and the one component that must behave identically in tests
and in the enclave.

### 1.1 Schema

- [ ] `packages/sla/schema.json`: `version`, `clauses[]`
- [ ] Clause types: `schema`, `latency`, `priceRange` (spec §1)
- [ ] Two example SLAs in `fixtures/`: one the demo service honours, one its
      twin deliberately violates

### 1.2 `evaluate()`

- [ ] `evaluate(sla, observation) → { outcome, clauses: [{ id, type, pass,
      expected, actual }] }` where `outcome` is `PASS`, `FAIL`,
      or `DOWN`
- [ ] `observation = { status, headers, body, latencyMs, paidAmount }`
- [ ] Pure — no I/O, no clock, no network
- [ ] **No heavy dependencies.** It has to bundle into the CRE workflow;
      hand-roll the JSON Schema subset rather than pulling ajv
- [ ] Per-clause failure detail in the return value — the dashboard shows
      *why* a call failed, not just that it did

### 1.3 Determinism

A verdict is final with no dispute (Requirements §4), so non-determinism
here is unrecoverable — it burns a real bond.

- [ ] Latency is an input, never measured inside `evaluate`
- [ ] Price comparison in integer minor units; no floating point
- [ ] No key-order or locale dependence
- [ ] Fixture round-trip test: same input → same output, asserted

### 1.4 Tests (TDD)

- [ ] Table-driven per clause type
- [ ] Boundary cases: latency exactly at limit, price exactly at bounds
- [ ] Malformed SLA, missing fields, unknown clause type → **throws**, so
      the caller takes the status-only fallback rather than silently
      producing a FAIL (spec §1)
- [ ] Status-only fallback path: 2xx PASS, 5xx `FAIL`, 4xx
      returns no verdict at all

---

## Phase 2 — Registry and escrow on Arc (days 3–5)

### 2.1 `contracts/src/VerdiktRegistry.sol`

Registrar and escrow in one contract for MVP.

- [ ] `register(bytes32 serviceId) payable` — `msg.value == DEPOSIT`
- [ ] `topUp(bytes32 serviceId) payable`
- [ ] `deregister(bytes32 serviceId)` — provider only, reverts while
      SUSPENDED
- [ ] `enum Outcome { PASS, FAIL, DOWN }`
- [ ] `setVerdict(bytes32 serviceId, bytes32 requestId, Outcome outcome,
      address payer, uint256 paidAmount)` — verifier role only
- [ ] Refund on either FAIL or DOWN: `min(fixedRefund, paidAmount, remainingDeposit)`
- [ ] `requestId` recorded; a second refund on the same request reverts
- [ ] Auto-suspend when the deposit hits zero
- [ ] `withdraw()` — agent collects credited refunds
- [ ] Events: `ServiceRegistered`, `VerdictWritten` (carrying `outcome`),
      `RefundCredited`, `RefundWithdrawn`, `ServiceSuspended`,
      `ServiceDeregistered`
- [ ] Views: `getVerdict`, `getDeposit`, `getStatus`, `getOwed`

### 2.2 Payout safety — pull payments

`setVerdict` books `owed[payer] += amount` and sends nothing. The agent
calls `withdraw()` to collect.

- [ ] No external call anywhere in `setVerdict`
- [ ] `withdraw()` zeroes the balance before transferring (checks-effects-
      interactions); a guard is then belt-and-braces

Rationale: pushing value during `setVerdict` would let a payer address that
rejects transfers revert the whole transaction and erase its own FAIL
verdict — a provider farming its own service through a reverting contract
could hold a spotless conformance ratio while failing real calls. It is
also strictly less code than a push-with-fallback.

For the demo, have the seed script call `withdraw()` right after a FAIL so
the dashboard still shows an end-to-end refund without a manual step.

### 2.3 Tests (Foundry)

State machine, table-driven:

- [ ] `register` → ACTIVE
- [ ] Either FAIL or DOWN → refund credited, deposit decremented, `RefundCredited`
      emitted
- [ ] `PASS` → no credit, deposit untouched
- [ ] `paidAmount < fixedRefund` → credit equals `paidAmount`
- [ ] Credit larger than the remaining deposit → books the remainder,
      SUSPENDED
- [ ] SUSPENDED → `deregister` reverts
- [ ] `topUp` → ACTIVE again
- [ ] Same `requestId` twice → reverts
- [ ] Non-verifier `setVerdict` → reverts
- [ ] Provider calling `setVerdict` → reverts (spec §3, one role per service)
- [ ] Reverting payer → verdict still written, credit still booked
- [ ] Reentrant `withdraw` → no double payout
- [ ] `withdraw` with nothing owed → reverts or no-ops, never underflows

### 2.4 Deploy

- [ ] Deploy to Arc Testnet
- [ ] Record addresses in `deployments/arc-testnet.json`
- [ ] Grant the verifier role to the CRE workflow signer from 0.3

---

## Phase 3 — CRE workflows (days 5–8)

### 3.1 Per-request confidential workflow

Inputs: `serviceId`, target URL, method, headers, body, `X-PAYMENT`.

- [ ] Resolve the `sla` text record from the Sepolia resolver
- [ ] Replay the payment against the provider; measure latency
- [ ] `evaluate(sla, observation)`
- [ ] Write `setVerdict` to Arc
- [ ] Return payload + verdict to the proxy
- [ ] Keep request credentials encrypted in-enclave
- [ ] Classify the outcome: no usable response → `DOWN`;
      response that broke a clause → `FAIL`
- [ ] **SLA-unavailable fallback**: ENS unreachable or SLA malformed →
      status-only default (2xx PASS, 5xx `FAIL`, 4xx no verdict),
      response still relayed (spec §1)

### 3.2 Hourly aggregate workflow (plain, cron)

- [ ] Read `VerdictWritten` over the trailing 7 days from Arc
- [ ] Conformance = `PASS ÷ (PASS + FAIL) × 1000`; unreachable
      calls excluded from the denominator
- [ ] Availability = `(PASS + FAIL) ÷ all verdicts × 1000`
- [ ] **Empty window → both ratios 1000**, not 0 — a service with no traffic
      is presumed healthy (spec §1). Guard the divide-by-zero explicitly;
      getting this backwards would brand every new listing as broken
- [ ] Write both text records to the ENS subname
- [ ] Makes no Arc write and settles no refund (spec §2)

### 3.3 Simulation harness

- [ ] Both workflows green under `cre workflow simulate` against the
      Phase 0 fixtures
- [ ] Capture the simulation output — it is the submission's evidence, since
      production enrollment is private-beta

---

## Phase 4 — Proxy (days 8–9)

Much smaller than originally scoped: no wallet, no signing, no correlation
store.

### 4.1 Routing

- [ ] `ALL /:slug/*` → target resolved from the registry
- [ ] Branch on the presence of `X-PAYMENT`

### 4.2 Passthrough branch

- [ ] Forward the request; capture the 402 challenge
- [ ] Resolve the slug's ENS address record (cache with a TTL)
- [ ] Compare against the challenge's `payTo`
- [ ] On mismatch: return an error and **do not relay the challenge** — the
      agent must never see a spoofed `payTo` to sign against
- [ ] Otherwise relay the challenge unchanged

### 4.3 Verified branch

- [ ] `decodePayment(header)` → payer, amount
- [ ] Refuse if the service is SUSPENDED, **before** the agent's payment is
      spent
- [ ] Trigger the workflow; await payload + verdict
- [ ] Relay the payload; attach `X-Verdikt-Verdict`, `X-Verdikt-Request-Id`,
      `X-Verdikt-Tx` response headers
- [ ] Never log or persist a response body (spec §2)

### 4.4 Failure modes

- [ ] Enclave got the response but the Arc write failed → **still relay the
      payload** (the agent paid for it) and retry the write asynchronously
- [ ] Workflow timeout → surface a distinct error; the agent has paid, so
      this must be visible, not swallowed
- [ ] Provider 5xx → that is an SLA failure, not a proxy error; it must
      reach `evaluate` rather than short-circuiting

### 4.5 SDK

- [ ] `packages/sdk` wrapping the Arc views and the ENS reads so callers
      don't need to know two chains are involved (spec §3)
- [ ] **Fold the read path out of `scripts/ens-sepolia.mjs`.** Implementing
      `resolveServiceRecord` puts the Universal Resolver address, the resolver's
      getter ABI and DNS encoding in `packages/sdk/ens.js` — where the spike
      scripts already have them. Two files knowing the ENSv2 deployment is the
      duplication the "only file that knows ENS exists" rule exists to prevent,
      and an address that moves in the beta then has to be fixed twice. Make
      the SDK the source of truth and have the scripts import it, leaving
      `ens-sepolia.mjs` the registrar/factory/anvil surface the SDK must never
      carry (see docs/spikes/A-ens-sepolia.md)

---

## Phase 5 — Marketplace dashboard (days 9–12)

The primary demo surface (spec §5) — budget real time for it, and use the
day saved in Phase 4 here.

### 5.1 Data layer

- [ ] Arc event reads over plain RPC, no subgraph (spec §3)
- [ ] ENS reads for `sla`, `conformance`, `availability`
- [ ] Both through `packages/sdk`

### 5.2 Views

- [ ] Service list: slug, conformance, availability, deposit, status, price
- [ ] Service detail: rendered SLA, verdict history, refund history
- [ ] Per-verdict failure detail — which clause failed, expected vs actual
- [ ] Platform stats: services registered, verdict breakdown, refunds paid
      over time

### 5.3 Stretch, in the spec's priority order

- [ ] Provider self-serve dashboard (own history, balance, SLA editor)
- [ ] Machine-facing discovery API

---

## Phase 6 — Demo and submission (days 12–14)

### 6.1 Seed

- [ ] Honest service: Proceeds paywall wrapping Open-Meteo
- [ ] Violating twin: same upstream, an SLA it cannot meet (a latency bound
      below the real p99, or a schema clause the paywall won't satisfy)

### 6.2 Scripted end-to-end run

- [ ] Register both, publish SLAs to ENS, fund bonds
- [ ] Happy path call → PASS, verdict on Arc, dashboard updates
- [ ] Violating call → FAIL → refund paid, visible on the dashboard
- [ ] Repeat until the bond drains → SUSPENDED → proxy refuses routing
- [ ] `payTo` mismatch → proxy blocks before payment

### 6.3 Submission

- [ ] Recorded walkthrough
- [ ] README
- [ ] State the scope decisions confidently rather than apologetically: no
      dispute layer is a design choice; ENS on Sepolia is a deployment
      constraint; attestation is simulated because CRE production
      enrollment is private-beta
