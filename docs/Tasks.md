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

Run. Findings in [spikes/cre.md](./spikes/cre.md), code in `cre/spike/`.

- [ ] `cre workflow simulate` on a hello-world
- [x] Confirm an HTTP trigger, an outbound HTTP call from inside the
      workflow, and an EVM write
- [x] Confirm an **Arc chain selector exists** for the EVM write capability
- [ ] Confirm confidential mode simulates
- [x] **Decide the workflow language.** The CRE SDK is Go or TypeScript. TS
      lets `packages/sla` be imported directly; Go means the evaluation
      engine is written twice and the two copies can drift — which for a
      final, undisputable verdict is a correctness risk, not just
      duplication. Strong preference for TS

Deliverable: `cre/spike/` green under `simulate`.

> **Gate — day 3: passed.** `arc-testnet` (`3034092155422581607`) is a
> supported CRE write target, so verdicts go straight from the workflow and
> need no relay path. Language: **TypeScript** — `@verdikt/sla` and
> `@verdikt/sdk` were confirmed to typecheck and bundle into the WASM binary,
> so the evaluation engine is shared rather than ported.

The two unchecked boxes are one blocker, not two: `cre workflow simulate`
refuses to run without a logged-in CRE account, and `cre login` needs a
browser. `bun run test` and `bun run compile` in `cre/spike/verify` carry the rest of
the evidence and need no credentials.

Two findings reshape work downstream, both detailed in
[spikes/cre.md](./spikes/cre.md):

- **Phase 2 changes shape.** A workflow cannot call `setVerdict`; writes
  arrive through the KeystoneForwarder as `onReport(metadata, report)`. The
  registry becomes an `IReceiver` and the verifier role becomes the forwarder
  address plus a `workflowOwner` check on the report metadata. The §3
  invariants — pull payments, the refund cap — are untouched.
- **The proxy's request path has an open question.** Whether the workflow's
  return value reaches the caller on the same HTTP request is contradicted
  between two Chainlink docs pages, and `Specification.md` §2 needs the
  permissive reading. One logged-in `simulate --listen` run settles it; do
  that before Phase 3.

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

**Done** — `packages/sla`, 75 tests green. Two decisions are recorded below
because neither is derivable from the spec text.

### 1.1 Schema

- [x] `packages/sla/schema.json`: `version`, `clauses[]`
- [x] Clause types: `schema`, `latency`, `priceRange` (spec §1)
- [x] Two example SLAs in `fixtures/sla/`: `honest.json`, which the demo
      service satisfies, and `violating.json`, whose schema and latency
      clauses the same upstream cannot meet

`schema.json` is executable, not documentation: the engine validates every
incoming SLA against it using its own JSON Schema subset, so there is no
second copy of "what a valid SLA is" to drift.

> **Decision — an empty `clauses` array is invalid.** `minItems: 1`. A
> zero-clause SLA would make `evaluate` return PASS for everything including a
> 500, which is a free spotless conformance ratio for any provider that
> publishes one. Rejecting it routes that provider to the status-only fallback,
> where a 5xx is correctly a FAIL.

### 1.2 `evaluate()`

- [x] `evaluate(sla, observation) → { outcome, clauses: [{ id, type, pass,
      expected, actual }] }` where `outcome` is `PASS`, `FAIL`,
      or `DOWN`
- [x] `observation = { status, headers, body, latencyMs, paidAmount }`
- [x] Pure — no I/O, no clock, no network
- [x] **No heavy dependencies.** It has to bundle into the CRE workflow;
      hand-roll the JSON Schema subset rather than pulling ajv
- [x] Per-clause failure detail in the return value — the dashboard shows
      *why* a call failed, not just that it did

> **Decision — an implicit `delivery` clause, and where the 4xx carve-out
> stops.** Spec §1 scopes "4xx → no verdict" to the status-only fallback and
> says nothing about status handling when the SLA *is* readable. Read literally
> that leaves a hole: an SLA declaring only a latency bound would collect a PASS
> for a 500 returned in 5ms, making the full path more lenient than the
> fallback. So every evaluation now carries an implicit first clause, id
> `delivery`, that fails on 5xx and on no-response; the id is reserved and an
> SLA declaring it is rejected.
>
> A **4xx deliberately passes** that clause and is left to the declared clauses.
> The fallback's carve-out exists because Verdikt is guessing with no SLA to
> read; with a readable SLA the provider holds the pen (§4) and can declare what
> its own rejections look like, and the refund cap (spec §3) already keeps
> garbage-request farming at break-even-minus-gas.

`pattern` is deliberately absent from the JSON Schema subset — it is the one
keyword whose evaluation cost is unbounded in the input, and the SLA is
authored by the party whose bond is at stake. Unsupported keywords **throw**
rather than being ignored, and `assertSchema` walks the whole schema up front
so an unsupported keyword in a branch no response reaches still throws.

### 1.3 Determinism

A verdict is final with no dispute (Requirements §4), so non-determinism
here is unrecoverable — it burns a real bond.

- [x] Latency is an input, never measured inside `evaluate`
- [x] Price comparison in integer minor units; no floating point
- [x] No key-order or locale dependence — object members are visited in
      sorted key order, so two bodies differing only in key order produce
      identical failure reports
- [x] Fixture round-trip test: same input → same output, asserted
- [x] `packages/sla/vectors.json` — language-neutral conformance vectors.
      Spike B chose TypeScript so no port is needed, but if one is ever forced
      these are what make it verifiable rather than taken on trust

### 1.4 Tests (TDD)

- [x] Table-driven per clause type
- [x] Boundary cases: latency exactly at limit, price exactly at bounds,
      price either side of 2^53 to prove the bigint path
- [x] Malformed SLA, missing fields, unknown clause type → **throws**, so
      the caller takes the status-only fallback rather than silently
      producing a FAIL (spec §1)
- [x] Status-only fallback path: 2xx PASS, 5xx `FAIL`, 4xx
      returns no verdict at all — as does anything else outside those bands,
      since a 1xx or 3xx is no more a delivered payload than a 4xx is

---

## Phase 2 — Registry and escrow on Arc (days 3–5)

**Done except deployment** — `contracts/`, 35 Foundry tests green.
Spike B's finding CRE-2 reshaped the entry point before any of this was
written; §2.1 below reflects the shape actually built.

### 2.1 `contracts/src/VerdiktRegistry.sol`

Registrar and escrow in one contract for MVP.

- [x] `register(string calldata slug) payable` — `msg.value == DEPOSIT_AMOUNT`,
      returns `keccak256(bytes(slug))`
- [x] Slug validated as a label both DNS and ENS accept, and a deregistered
      slug is never re-registerable — verdict history is keyed by `serviceId`,
      so reuse would hand a new provider the previous one's record
- [x] `topUp(bytes32 serviceId) payable`
- [x] `deregister(bytes32 serviceId)` — provider only, reverts while
      SUSPENDED
- [x] `enum Outcome { PASS, FAIL, DOWN }`
- [x] ~~`setVerdict(...)` — verifier role only~~ → **`onReport(metadata,
      report)`**, see the decision below
- [x] Refund on either FAIL or DOWN: `min(FIXED_REFUND, paidAmount, remainingDeposit)`
- [x] `requestId` recorded; a second report on the same request writes nothing
      and pays nothing
- [x] Auto-suspend when the deposit hits zero
- [x] `withdraw()` — agent collects credited refunds
- [x] Events: `ServiceRegistered`, `VerdictWritten` (carrying `outcome`),
      `VerdictRejected`, `RefundCredited`, `RefundWithdrawn`,
      `ServiceSuspended`, `ServiceReinstated`, `ServiceDeregistered`
- [x] Views: `getVerdict`, `getService`, `getDeposit`, `getStatus`,
      `getProvider`, `getOwed`

> **Decision — the verdict entry point is `onReport`, not `setVerdict`.**
> Absorbed from Spike B (CRE-2). A CRE workflow holds no key and sends no
> transaction, so no `verifier` EOA can exist. The registry implements
> `IReceiver`; the KeystoneForwarder delivers a DON-signed report. Because the
> forwarder is shared infrastructure, `msg.sender` alone would let *any* CRE
> user on Arc write Verdikt verdicts — so the pinned `workflowOwner` from the
> report header is the real access control, with an optional `workflowName`
> pin on top. §3 invariants are untouched: the credit is still booked and never
> pushed, and the refund cap is unchanged.
>
> **Corollary — a declined report emits rather than reverts.** `onReport`
> returns nothing and the forwarder does not surface a revert usefully, so a
> duplicate `requestId`, an unknown service or a deregistered one emits
> `VerdictRejected` and returns. This is a deliberate departure from spec §3's
> "a second refund against the same request reverts": the invariant that
> matters is that it is not paid twice, and reverting would make the reason
> invisible. Authentication failures and malformed reports still revert.

> **Decision — reinstatement requires the full bond, not merely a non-zero
> one.** Suspension is at zero (spec §3), but `topUp` only returns a service to
> ACTIVE once its deposit is back at `DEPOSIT_AMOUNT`. Waking it on dust would
> leave it listed while every refund it owed was capped at that dust.

> **Unverified — the 109-byte report header layout.** `ReportMetadata`'s
> offsets come from the KeystoneForwarder's documented header and are
> cross-checked against the 109-byte total the spike recorded, but have not been
> observed against a live forwarder call. A wrong `workflowOwner` offset rejects
> every verdict. Confirming it is an explicit step in 2.4.

### 2.2 Payout safety — pull payments

The verdict path books `owed[payer] += amount` and sends nothing. The agent
calls `withdraw()` to collect.

- [x] No external call anywhere in the verdict path
- [x] `withdraw()` zeroes the balance before transferring (checks-effects-
      interactions); a guard is then belt-and-braces

Rationale: pushing value while recording a verdict would let a payer address
that rejects transfers revert the whole transaction and erase its own FAIL
verdict — a provider farming its own service through a reverting contract
could hold a spotless conformance ratio while failing real calls. It is
also strictly less code than a push-with-fallback.

For the demo, have the seed script call `withdraw()` right after a FAIL so
the dashboard still shows an end-to-end refund without a manual step.

### 2.3 Tests (Foundry)

State machine, table-driven:

- [x] `register` → ACTIVE
- [x] Either FAIL or DOWN → refund credited, deposit decremented, `RefundCredited`
      emitted
- [x] `PASS` → no credit, deposit untouched
- [x] `paidAmount < fixedRefund` → credit equals `paidAmount`
- [x] Credit larger than the remaining deposit → books the remainder,
      SUSPENDED
- [x] SUSPENDED → `deregister` reverts
- [x] `topUp` → ACTIVE again (only back at the full deposit; dust does not wake it)
- [x] Same `requestId` twice → `VerdictRejected`, nothing paid twice
- [x] A report from any caller but the forwarder → reverts
- [x] A report from another `workflowOwner` on the same forwarder → reverts
- [x] Provider writing a verdict → reverts (spec §3, one role per service)
- [x] Reverting payer → verdict still written, credit still booked
- [x] Reentrant `withdraw` → no double payout
- [x] `withdraw` with nothing owed → reverts, never underflows
- [x] Fuzz: credit is simultaneously ≤ `paidAmount`, ≤ `FIXED_REFUND` and
      ≤ the remaining deposit, for every outcome
- [x] Solvency: contract balance always equals bonds plus credits
- [x] `serviceIdOf` agrees with `packages/sdk/registry.js` on shared vectors —
      both sides assert the same two hashes

### 2.4 Deploy

- [x] `contracts/script/Deploy.s.sol`, parameterised by forwarder, workflow
      owner, deposit and refund
- [ ] **BLOCKED** — deploy to Arc Testnet. `ARC_RPC_URL` and a funded
      `DEPLOYER_PRIVATE_KEY` are both empty in `.env`; nothing in the repo can
      supply either. Everything downstream that needs a deployed address is
      blocked with it (2.4's remaining boxes, 3.x's live writes, Phase 6)
- [ ] Record addresses in `deployments/arc-testnet.json`
- [ ] Confirm the `ReportMetadata` offsets against a real forwarder delivery
      before trusting a live verdict — a wrong offset rejects every one of them
      and the forwarder will not say why

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

- [x] `<slug>.verdikt.bond/*` **and** `/:slug/*` — the host form is how agents
      actually call; the path form keeps local development off wildcard DNS
- [x] Branch on the presence of `X-PAYMENT`
- [x] Refuse a SUSPENDED, DEREGISTERED or unregistered service before any
      upstream call — on the unpaid leg too, since an agent that never sees a
      challenge cannot pay one
- [x] Target resolved from the **ENS `url` record**, not the registry — see the
      decision below

> **Decision — the upstream endpoint is an ENS text record.** §4.1 said "target
> resolved from the registry", but the registry has no such field and adding
> one costs a chain write per URL change, a second provider-writable field, and
> an Arc read on the unpaid leg that is otherwise unnecessary. The URL is
> provider-authored and not consensus-critical, which is exactly what the ENS
> side is for, and the per-key EAC that already scopes `sla` to the provider
> covers `url` for free. `ServiceRecord` gains a fifth record and the proxy
> still makes one resolution call.

### 4.2 Passthrough branch

- [x] Forward the request; capture the 402 challenge
- [x] Resolve the slug's ENS address record (cached, TTL from
      `PROXY_ENS_CACHE_TTL_MS`)
- [x] Compare against the challenge's `payTo` — **every** option in `accepts`,
      since the agent may pick any of them
- [x] On mismatch: return an error and **do not relay the challenge** — the
      agent must never see a spoofed `payTo` to sign against. Also blocks when
      the challenge will not parse, offers no `payTo`, or the service has
      published no address to compare against
- [x] Otherwise relay the challenge unchanged
- [x] Refuse a provider `url` pointed at a private or link-local host. The
      record is provider-authored and the proxy dials it from Verdikt's own
      network, so without this it is a server-side-request-forgery primitive;
      `PROXY_ALLOW_PRIVATE_UPSTREAM` opts a localhost demo provider back in

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

- [x] `resolveServiceRecord` — all four records in one batched round trip,
      `sla` raw and unparsed, unwritten records `null`
- [x] `serviceIdOf` — agrees with the contract on shared vectors
- [x] **Fold the read path out of `scripts/ens-sepolia.mjs`.** Done: the
      Universal Resolver address, the record ABI and DNS encoding now live only
      in `packages/sdk/ens.js`, and `ens-sepolia.mjs` imports them. It keeps the
      registrar, factory, EAC-onboarding and anvil surface, which the SDK must
      never carry
- [ ] Arc views (`getService`, `getVerdict`, `getOwed`, `VerdictWritten` log
      replay) — landing with Phase 5's data layer, which is their only consumer

> **Bug the tests caught, worth not reintroducing.** viem wraps a *transport*
> failure in `ContractFunctionExecutionError`, the same class as a revert. The
> first cut treated that class as "the name has no records", which silently
> turned a Sepolia outage into a marketplace where no provider had published
> anything — and, downstream, into every call taking the status-only fallback.
> `isChainLevelRefusal` is now a positive test for an actual revert, and
> anything unrecognised propagates.

> **Constraint this surfaced, and it reshapes 3.2.** `writeServiceScores` is an
> **EOA** path, for the seed and operational scripts. The hourly CRE workflow
> cannot use it: a workflow holds no key, and its only on-chain write is a
> DON-signed report delivered to an `IReceiver` (Spike B, CRE-2). An ENS
> resolver is not an `IReceiver`, so the workflow cannot call `setText` at all.
> §3.2 therefore needs a `VerdiktScoreWriter` receiver on Sepolia holding the
> key-scoped EAC roles, with the workflow writing a report to it. (see docs/spikes/A-ens-sepolia.md)

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
