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

- [x] pnpm workspace:
  - `contracts/` — Foundry (Solidity)
  - `packages/sla/` — evaluation engine (JS, ESM)
  - `packages/sdk/` — Arc + ENS read wrapper (spec §3)
  - `cre/` — the two workflows
  - `proxy/` — Fastify
  - `web/` — dashboard
  - `fixtures/` — recorded challenges, payloads, responses
- [x] Vitest at the root; JS + ESM throughout except where the CRE SDK
      forces otherwise (see 0.3) — `cre/workflows` is that exception, a bun
      island with its own toolchain
- [x] `.env.example` with the Arc and Sepolia RPCs. **Not** contract
      addresses: those are `deployments/*.json` and code — see the decision in
      2.4
- [x] CI: lint + typecheck + `vitest run` + `forge fmt --check` + `forge test`
      on push (`.github/workflows/ci.yml`). Simulation is deliberately absent —
      it needs an interactive login (CRE-1)

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

- [x] `cre workflow simulate` on a hello-world
- [x] Confirm an HTTP trigger, an outbound HTTP call from inside the
      workflow, and an EVM write
- [x] Confirm an **Arc chain selector exists** for the EVM write capability
- [x] Confirm confidential mode simulates
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

> **Both closed, 2026-09-07.** The one-time `cre login` has been done, and
> `cre workflow simulate verify --listen` runs green in confidential mode — the
> run prints the TEE banner and completes the handler inside it. Captured in
> [evidence/cre-simulate-verify.log](./evidence/cre-simulate-verify.log).
> Simulation still cannot be a CI check, because the login is interactive.

Two findings reshape work downstream, both detailed in
[spikes/cre.md](./spikes/cre.md):

- **Phase 2 changes shape.** A workflow cannot call `setVerdict`; writes
  arrive through the KeystoneForwarder as `onReport(metadata, report)`. The
  registry becomes an `IReceiver` and the verifier role becomes the forwarder
  address plus a `workflowOwner` check on the report metadata. The §3
  invariants — pull payments, the refund cap — are untouched.
- **The proxy's request path is settled, restrictively.** The `--listen` run
  above answered it: the trigger POST returns 200 with an empty body in under a
  millisecond, and the handler's return value appears in the simulator, not in
  that response. `Specification.md` §2 needed the permissive reading and does
  not get it, so the proxy triggers and then **blocks on the execution result**
  rather than reading the response itself — keeping the provider's bytes inside
  the enclave, which is the argument §2 is built on.

### 0.4 Spike C — `X-PAYMENT` decoding

Every refund depends on recovering the payer and the amount from the header.

- [ ] **BLOCKED (external)** — capture a real `GatewayWalletBatched`
      `X-PAYMENT` header from a live paid call on Arc Testnet. Needs a funded
      Circle Gateway balance and a paying agent; the scheme debits a pre-funded
      Gateway balance rather than a plain token balance (Requirements §9)
- [ ] Decode it; extract payer address and paid amount — blocked on the above
- [ ] **Verify those fields are cryptographically bound** — signed by the
      payer, not merely asserted in a JSON blob. The refund target is read
      out of this header, so if the binding is weak, anyone can name a
      different payer and redirect refunds. Blocked on the above
- [x] Confirm the amount is in known minor units — **answered from the
      challenge alone**, without a paid call. The captured
      `GatewayWalletBatched` option carries
      `extra.assets[{symbol: "USDC", address: "0x3600…0000", decimals: 6}]`, and
      `amount` is a decimal string of those units. That is the 6-decimal ERC-20
      view, which is what `VerdiktRegistry.NATIVE_PER_MINOR_UNIT` converts from

Deliverable: `packages/sdk/payment.js` with `decodePayment(header)` plus a
fixture test.

> **Fallback.** If payer/amount aren't verifiable from the header alone,
> take them from the settlement receipt instead and have the enclave
> confirm settlement before writing a verdict.

### 0.5 Freeze fixtures

- [x] 402 challenge JSON — **real**, captured from the demo Proceeds paywall
      into `fixtures/x402/`, with the provider's `payment-required` header
      beside it. `proxy/src/app.test.js` runs the payTo check against it
- [x] Provider 200 response — `PROVIDER_RESPONSE` in `fixtures/`, the Open-Meteo
      `current` block the demo SLAs are written against
- [ ] `X-PAYMENT` header and settlement receipt — blocked with 0.4
- [x] Everything downstream develops against these — no live paid call needed
      to run a test. The one exception is the payment header itself, which is
      why `decodePayment` refuses to run without an explicit opt-in

### 0.6 Domain

- [x] **`verdikt.bond` is registered.** RDAP: created 2026-09-06, expires
      2027-09-06, registrar NameCheap, nameservers `edna`/`sri.ns.cloudflare.com`,
      status `add period`. Registered the same day as `verdikt.eth` on Sepolia,
      which is strong circumstantial evidence it is ours — RDAP redacts the
      registrant, so ownership is not provable from outside and is worth a
      one-line confirmation. No fallback host needed; `PROXY_PUBLIC_HOST`
      stands as-is. What remains is DNS: a wildcard `*.verdikt.bond` record
      pointing at the proxy
- [x] **ENS parent name.** `verdikt.eth` is registered on Sepolia ENSv2
      (expires 2027-09-06) with a `PermissionedResolver` attached, so
      the parent name in `deployments/sepolia.json` stands as-is. Its subregistry is not deployed yet —
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

> **The 109-byte report header layout — now confirmed against the SDK.**
> `ReportMetadata`'s offsets match `REPORT_METADATA_OFFSETS` in
> `@chainlink/cre-sdk`'s own parser field for field (spike finding CRE-8). Also
> settled there: `workflowName` is raw UTF-8, not a hash, so pinning the full
> workflow name works — Solidity truncates it to the same ten bytes the
> forwarder carries. Not yet seen on a live delivery, so the residual risk is a
> header version change rather than a wrong offset.

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

> **Decision — addresses are not configuration.** Three kinds of value were
> tangled in `.env`, and only one of them belonged there:
>
> | | Where it lives now |
> |---|---|
> | Constants of someone else's deployment — ENSv2's protocol contracts, Chainlink's forwarders, Arc's chain id | code: `scripts/ens-sepolia.mjs`, `packages/sdk/{ens,arc}.js`, the deploy scripts |
> | Verdikt's own deployed addresses | `deployments/*.json`, checked in |
> | RPC URLs, keys, ports, timeouts | `.env` |
>
> A value nobody can change per environment is not configuration. Keeping one in
> `.env` makes it something every contributor has to be handed out of band, that
> nothing validates, and that can silently disagree with the code — which is how
> `ENS_PARENT_NODE` and `ENS_SUBNAME_REGISTRY_ADDRESS` ended up as a hash nobody
> checked and a variable nothing read. Solidity reads `deployments/` through
> `vm.parseJson`, which is why `foundry.toml` grants read access to it.

- [x] `contracts/script/Deploy.s.sol`, parameterised by forwarder, workflow
      owner, deposit and refund
- [x] Deployed to Arc Testnet
- [x] `deployments/arc-testnet.json` and `deployments/sepolia.json` exist and
      are the source of truth for Verdikt's own addresses; `registry` is `null`
      until the deploy runs. See the decision below
- [x] Recorded in `deployments/arc-testnet.json`, with the deploy block that
      bounds every log scan
- [x] `VerdiktScoreWriter` deployed to Sepolia and recorded in
      `deployments/sepolia.json`
- [x] Confirm the `ReportMetadata` offsets against a real forwarder delivery —
      **and they were wrong.** A traced `simulate --broadcast` delivery reverted
      `MalformedReportMetadata(64)`: a receiver is handed 64 bytes, not the 109
      the DON signs. The SDK cross-check had validated the wrong artefact. This
      is exactly the silent failure the box existed to catch, and only an actual
      delivery caught it (CRE-8)
- [ ] **BLOCKED (external)** — `cre account link-key` to establish a production
      `CRE_WORKFLOW_OWNER`. `cre account list-key` reports none linked and
      `cre whoami` shows "Deploy Access: Not enabled", the private-beta gate.
      Until then the deployment pins the simulation forwarder and the
      `workflowOwner` simulation actually sends; both are immutable, so
      production is a redeploy

---

## Phase 3 — CRE workflows (days 5–8)

Both workflows live in `cre/workflows/`. Everything that decides whether a bond
is touched, or what number is published under a provider's name, is in
`cre/lib/` as plain JS under vitest — `simulate` needs an interactive login, so
logic that lives only in a `.ts` workflow is logic nothing tests per commit.

### 3.1 Per-request confidential workflow

Inputs: `serviceId`, `requestId`, target URL, method, `X-PAYMENT`, payer,
paid amount, and the raw `sla` record.

- [x] The `sla` text record — resolved by the **proxy** and passed in, not read
      in the enclave. `packages/sdk/ens.js` is the only file that knows ENS
      exists, and the enclave is not the exception; it arrives raw so the
      engine, not the workflow, decides whether it parses
- [x] Replay the payment against the provider; measure latency
- [x] `evaluate(sla, observation)` — the real `@verdikt/sla`, bundled into the
      WASM binary (asserted by grepping the bundle for its error strings)
- [x] Write the verdict to Arc as a DON-signed report
- [x] Return the verdict to the proxy
- [x] Keep request credentials in-enclave — no `runtime.log` of the body, and a
      failed request's message is discarded rather than echoed, since logs leave
      the enclave
- [x] Classify the outcome: no usable response → `DOWN`;
      response that broke a clause → `FAIL`
- [x] **SLA-unavailable fallback**: unreadable or malformed SLA →
      status-only default (2xx PASS, 5xx `FAIL`, 4xx no verdict)
- [x] A `null` outcome writes **nothing** — `onReport` cannot express "no
      verdict", so the skip happens before a report is built

### 3.2 Hourly aggregate workflow (plain, cron)

- [x] Read `VerdictWritten` over the trailing 7 days from Arc
- [x] Conformance = `PASS ÷ (PASS + FAIL) × 1000`; unreachable
      calls excluded from the denominator
- [x] Availability = `(PASS + FAIL) ÷ all verdicts × 1000`
- [x] **Empty window → both ratios 1000**, not 0 — and the service list is
      built from `ServiceRegistered`, not from the verdicts, because a
      zero-traffic service can only be *published* as 1000 if it appears in the
      list at all
- [x] Write both text records to the ENS subname
- [x] Makes no Arc write and settles no refund (spec §2)

> **Constraint — the workflow cannot call `setText`.** A workflow holds no key
> and its only on-chain write is a DON-signed report to an `IReceiver`; an ENS
> resolver is not one. `contracts/src/VerdiktScoreWriter.sol` on Sepolia holds
> the key-scoped EAC roles and calls `setText` itself. The report carries the
> **slug**, not a node, and the node is derived from an immutable parent — so a
> report can only ever address a child of `verdikt.eth`.
>
> Deployed by `contracts/script/DeployScoreWriter.s.sol`. Deployment alone is
> not enough: the operator must then grant it `conformance` and `availability`
> **per key** with `authorizeTextRoles` on each subname. Never name-wide with
> `authorizeNameRoles` — Spike A found that grant is one of the two routes that
> bypasses the per-key ACL the ENSv2 choice rests on.

> **Naming — there is no "verifier" address any more.** `VERIFIER_PRIVATE_KEY`
> named a role that no longer exists: Spike B moved the Arc verdict write to
> DON-signed reports, and the score writer above took the ENS write. It is now
> `ENS_SCORE_SIGNER_PRIVATE_KEY`, an EOA scoped to the two score keys for
> `writeServiceScores` and for the spike's ACL assertion — an out-of-band path,
> not how scores reach ENS in production.

> **Approximation — log timestamps.** An EVM log carries `blockNumber` but no
> timestamp, and a header read per block would be thousands of calls an hour.
> Logs are dated from the head block and a configured nominal block time. Fine
> *here specifically*: both ratios are display-only and recomputed hourly with
> no refund state behind them, so a verdict on the wrong side of the boundary
> costs a stale number for an hour. It would not be fine anywhere a refund
> depended on it.

### 3.3 Simulation harness

- [x] `verify` green under `cre workflow simulate --listen`, in confidential
      mode, driven by a real trigger POST
- [x] Capture the simulation output — it is the submission's evidence, since
      production enrollment is private-beta:
      [evidence/cre-simulate-verify.log](./evidence/cre-simulate-verify.log)
- [x] `aggregate` green under `simulate`, against the live Arc registry:
      `weather=1000/1000 weather-lite=0/1000`, computed from the two real
      `VerdictWritten` events. Captured in
      [evidence/cre-simulate-aggregate.log](./evidence/cre-simulate-aggregate.log)

> **Two traps, both of which look like a hang.** The simulator honours the cron
> schedule, so an unmodified hourly config sits silently until the top of the
> hour — swap to `*/15 * * * * *` to simulate. And `headerByNumber` has no
> negative-number "latest" sentinel: passing `-1` hangs with no error, where
> omitting `blockNumber` works.

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

- [x] `decodePayment(header)` → payer, amount — and **refuse to verify at all**
      if it cannot decode, since every refund targets the payer it returns
- [x] Refuse if the service is SUSPENDED, **before** the agent's payment is
      spent (checked on the unpaid leg too)
- [x] Trigger the workflow; await payload + verdict
- [x] Relay the payload; attach `X-Verdikt-Verdict`, `X-Verdikt-Request-Id`,
      `X-Verdikt-Tx`, plus `X-Verdikt-Mode` and `X-Verdikt-Fallback-Reason`
- [x] Never log or persist a response body (spec §2)
- [x] Refuse a paid call when no workflow is configured, rather than relaying
      one unverified

> **Decision — trigger, then block on the execution result.** Forced by Spike
> B's CRE-3: the trigger response does not carry the handler's return value. The
> alternative — the proxy makes the paid call and the enclave verifies after —
> was rejected twice over. It moves the reading of the provider's response out
> of the enclave, which is the argument §2 is built on; and it is not available
> anyway, because an x402 payment settles once, so the enclave's call *is* the
> call and its response is the only copy of what the agent bought.
>
> **How the result comes back (CRE-9).** Reading the gateway's actual contract
> corrected two things and broke a third. The JSON-RPC shape is
> `workflows.execute` with `params.input` / `params.workflow.workflowID`; the
> `Authorization` bearer is a per-request ECDSA-signed JWT whose payload digests
> the body, so it is a **key**, not a token; and no HTTP endpoint for reading an
> execution's result is documented at all, so there was nothing to poll.
>
> The workflow therefore **pushes** its result to a callback the proxy serves,
> correlated by `requestId`. Demonstrated end to end under
> `simulate --listen` — see
> [evidence/cre-callback-roundtrip.log](./evidence/cre-callback-roundtrip.log).
> Two things authenticate the callback: a shared bearer, and the `requestId`
> being 32 random bytes the proxy issued and has not yet answered.

> **Consequence worth stating rather than discovering.** The payload therefore
> crosses the DON boundary in the workflow's return value. It is no longer only
> ever inside the enclave. What attestation still buys is that the code
> *judging* it is fixed and published — which is §2's actual claim — but a
> provider should be told this plainly. The DON consensus observation is also
> capped, so a response over ~20kB comes back truncated and flagged with
> `X-Verdikt-Body-Truncated` rather than silently cut.

### 4.4 Failure modes

- [x] Enclave got the response but the Arc write failed → **still relays the
      payload** (the agent paid for it) and flags
      `X-Verdikt-Verdict-Unwritten`. The workflow does not throw on a failed
      write for the same reason: the verdict can be rewritten, the response
      cannot be refetched
- [x] Workflow timeout → 504 with `paid: true` and the `requestId`; the agent
      has paid, so this is visible, never swallowed
- [x] Provider 5xx → relayed as a 5xx with its verdict attached. It is an SLA
      failure the engine judged, not a proxy error, and rewriting it would hide
      from the agent what it actually bought

### 4.5 SDK

- [x] `resolveServiceRecord` — all four records in one batched round trip,
      `sla` raw and unparsed, unwritten records `null`
- [x] `serviceIdOf` — agrees with the contract on shared vectors
- [x] **Fold the read path out of `scripts/ens-sepolia.mjs`.** Done: the
      Universal Resolver address, the record ABI and DNS encoding now live only
      in `packages/sdk/ens.js`, and `ens-sepolia.mjs` imports them. It keeps the
      registrar, factory, EAC-onboarding and anvil surface, which the SDK must
      never carry
- [x] Arc views (`getService`, `getVerdict`, `getOwed`, and `VerdictWritten` /
      `ServiceRegistered` / `RefundCredited` log replay) in `packages/sdk/arc.js`,
      chunked so a public RPC's `eth_getLogs` cap cannot silently truncate a scan

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

- [x] Arc event reads over plain RPC, no subgraph (spec §3)
- [x] ENS reads for `url`, `sla`, `conformance`, `availability`
- [x] Both through `packages/sdk`; the dashboard knows neither an ABI nor a
      resolver address
- [x] A demo source, labelled in the header, for when no registry is configured

### 5.2 Views

- [x] Service list: slug, conformance, availability, deposit, status
- [x] Service detail: rendered SLA clauses, verdict history, refund per verdict
- [x] Platform stats: services registered, verdict breakdown, bonded, refunded
- [ ] **Per-verdict failure detail — which clause failed, expected vs actual.**
      Not reachable from chain data: `VerdictWritten` carries the outcome, payer
      and amount, and the clause results exist only in the workflow's return
      value, which goes to the proxy. The detail view shows what a service
      *promised* — the SLA clauses from ENS — beside what it delivered, which
      answers "what am I buying" but not "which clause broke on call 47".
      Closing it means adding the failing clause id to the report and the event;
      a `bytes32` would be cheap, and the dashboard already holds the clause
      list to map it back

> **Decision — no UI framework.** The whole surface is a list, a detail panel
> and a stats strip. A framework would be the largest dependency in the repo for
> markup that fits in one file, and the data layer — the part with the logic —
> is separated and unit-tested without a DOM.

> **Bug the screenshot caught.** Ranking by availability first put a service
> that answered every call and broke its SLA on every one of them *above* one
> that delivered correctly and blipped once — the marketplace recommending the
> worse option. It now ranks on the product of the two ratios, so neither can
> carry a listing alone.

### 5.3 Stretch, in the spec's priority order

- [ ] Provider self-serve dashboard (own history, balance, SLA editor)
- [ ] Machine-facing discovery API

---

## Phase 6 — Demo and submission (days 12–14)

### 6.1 Seed

- [x] The two SLAs exist as fixtures (`fixtures/sla/`) and drive both the demo
      script and the dashboard's demo source: an honest service, and a twin
      whose schema clause promises a field the upstream does not return and
      whose latency bound no round trip can meet
- [x] The live Proceeds paywall answers a real 402 on Arc — captured in
      `fixtures/x402/challenge-402.json`. It offers `GatewayWalletBatched` on
      `eip155:5042002` at 1 minor unit, paying to
      `0x5c33f235…16505`, which is the address a service's ENS `address` record
      has to match for the proxy to relay its challenge
- [ ] Point it at Open-Meteo and pair it with a violating twin — the paywall
      currently fronts a placeholder resource ("Access to Test")

### 6.2 Scripted end-to-end run

`pnpm demo` — [scripts/demo.mjs](../scripts/demo.mjs). Runs today, on a
throwaway `anvil` rather than Arc, because 2.4 is blocked. Same bytecode, same
report encoding, same refund arithmetic; what it does not exercise is Arc
itself, a real forwarder, and a real payment.

- [x] Register both, fund bonds
- [x] Happy path calls → PASS, no credit, deposit untouched
- [x] Violating calls → FAIL → refund credited, asserted against the cap
- [x] Repeat until the bond drains → SUSPENDED
- [x] A DOWN refunds too — that call took payment and delivered nothing
- [x] `withdraw()` pays exactly what was booked, asserted net of gas
- [x] Publish SLAs to ENS — `scripts/onboard-service.mjs` (`pnpm onboard`) does
      the per-service half `setup-ens.mjs` never did: mints
      `<slug>.verdikt.eth`, grants the provider `sla` + `url` and the score
      writer `conformance` + `availability` **per key**, and sets the address
      record. Both demo subnames are live on Sepolia with real records
- [x] Dashboard reads it live — the registry is deployed and recorded, so
      `VITE_ARC_RPC_URL` alone switches it off demo data
- [x] `payTo` mismatch → proxy blocks before payment. Demonstrated against
      live data on both chains: the ENS address record repointed at `0x…dEaD`
      while the provider's real challenge paid to `0x5c33f2…`, and the agent got
      a 502 carrying no `accepts` at all. Captured in
      [evidence/payto-check-live.log](./evidence/payto-check-live.log)

### 6.3 Submission

- [x] README, with a "what is real, and what is not" section — a verification
      product that overstated its own verification would be self-refuting
- [x] State the scope decisions confidently rather than apologetically: no
      dispute layer is a design choice; ENS on Sepolia is a deployment
      constraint; attestation is simulated because CRE production
      enrollment is private-beta
- [ ] Recorded walkthrough
