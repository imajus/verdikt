# CLAUDE.md

This file provides guidance to AI coding agents working with code in this repository. `AGENTS.md` is a symlink to it, so the instructions are the same whichever tool loads them.

## What Verdikt is

A marketplace of x402-gated API services whose delivery is verified per call. A proxy sits between a paying agent and an x402 provider, verifies the response against the provider's own declared SLA inside a Chainlink CRE Confidential Workflow, writes a verdict on-chain, and auto-refunds from the provider's bonded deposit when the SLA isn't met. There is no dispute or arbitration step by design.

`docs/` is the specification and takes precedence over inference from code:

- `docs/Requirements.md` — problem, scope, non-goals, open risks
- `docs/Specification.md` — mechanics; sections are cited throughout the code as `spec §N`
- `docs/Tasks.md` — the phased build plan, ordered by risk
- `docs/roadmap/erc-8004.md` — post-hackathon research: publishing verdicts to an ERC-8004 Validation Registry. Out of scope for the submission; read it before designing any interop, not after
- `docs/roadmap/input-validation.md` — post-hackathon research: rejecting a malformed request before it is paid for, closing the gap the 4xx invariant deliberately leaves. Blocked on the same boundary decision as [#21](https://github.com/imajus/verdikt/issues/21)

## Working branch

Work happens on `feat/genlayer`, never on `main`. Branch from it, commit to it, and open every new PR with `feat/genlayer` as the **base** — not `main`. `main` is only ever fast-forwarded from the remote. Drop this section once `feat/genlayer` merges.

## Current state

The loop runs end to end on public testnets. `docs/evidence/` holds the transcripts — every number in them was read back off a chain.

- **Arc Testnet** — `VerdiktRegistry` at `0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af`, block 60860488. Services are registered self-serve through the dashboard's wizard, each fronting a real third-party x402 provider (Alchemy, Allium, Syntalic, …), and the registry holds verdicts and refunds from real paid calls — `.claude/skills/verdikt-paid-call-sweep` is how that traffic is generated and read back. **Do not take the service list from this file**; read it off the chain with the sweep skill's `list-services.mjs`. A deregistered service is delisted — both the dashboard (`isListed` in `web/src/marketplace.js`) and the aggregate (`reputationForWindow` in `cre/lib/reputation.js`) drop it — but its detail page stays reachable by slug because the verdict history is permanent, and its slug can never be re-registered. `docs/evidence/` records an earlier pair, `weather` / `weather-lite`, since deregistered; that pair survives only as fixtures and the dashboard's demo data, for development.
- **Sepolia** — `verdikt.eth` with a subname per registered service, minted self-serve through `VerdiktSubnameRegistrar` at `0x247e46abe002c034CD99D8d81D7e6182b727ac7d` and carrying real `sla`, `url` and `address` records, plus `conformance`/`availability` published hourly through `VerdiktScoreWriter` at `0x542Cb024D71e0Cd0Ef40AB7603779C89895EFfAA`. The hourly run is a scheduled job in the `runner` container — a simulated cron never fires on its own.
- Both CRE workflows run under `cre workflow simulate --broadcast`, hosted by `runner/` (described under "Commands" below).

All three spikes have run. **A** (ENSv2) — `docs/spikes/A-ens-sepolia.md`. **B** (CRE) — `docs/spikes/cre.md`, findings CRE-1…CRE-10, several of which reshaped the contracts. **C** (payment header) — `docs/spikes/C-x402-payment.md`. Both `exact` transfer methods a real challenge offers verify through one ERC-3009 verifier: plain `eip3009` (a signature it produced settled on Base Sepolia) and Circle's `GatewayWalletBatched` (recovered against a real captured header, #41). A contract-account payer such as the Circle agent wallet is asked via ERC-1271 over the payment chain's RPC (`PAYMENT_<NAME>_RPC_URL`, #55). A genuinely unknown scheme still refuses, per header.

Two things are deliberately unfinished, each argued at its own task in `docs/Tasks.md`: production CRE enrollment (`cre whoami` → *Deploy Access: Not enabled*) and the recorded video. The paid leg runs end to end: real agents pay real providers through `<slug>.verdikt.bond`, the verify workflow judges the call, and the verdict and refund land on Arc. One gap remains on that leg — a Gateway-paid refund is booked to the agent wallet's *backing EOA*, which cannot call `withdraw()` on Arc; `withdrawWithAuthorization` closes it in the contract, but the live registry predates it and needs a redeploy (Tasks.md 2.4).

Production enrollment is blocked on more than access. CRE's `ChainRead.CallLimit` is **15 chain reads per run** and the hourly aggregate needs ~100, because it scans `ServiceRegistered` from the registry's deploy block and Arc mints two blocks a second. `cre/workflows/limits.json` raises that one limit for simulation; a deployable version needs the full-history scan gone, not a bigger number. See `cre/workflows/README.md`.

## Commands

```bash
pnpm lint                        # eslint
pnpm typecheck                   # tsc --noEmit against jsconfig.json
pnpm test                        # vitest run
pnpm vitest run path/to.test.js  # single test file
pnpm vitest run -t "name"        # single test by name
```

```bash
node --env-file=runner/.env runner/src/server.js   # simulate-mode CRE gateway, see runner/README.md
```

```bash
cd contracts
forge fmt --check                # CI enforces this
forge build
forge test
forge test --match-test testRefund     # single test
forge test --match-contract Registry   # single contract
```

```bash
cd web
pnpm dev                         # dashboard on :5173
pnpm run deploy                  # vite build && wrangler deploy. NOT `pnpm deploy` — that is pnpm's own command
```

```bash
cd proxy
pnpm dev                         # wrangler dev — local Workers runtime, real Durable Objects
pnpm run deploy                  # wrangler deploy
```

`web` is static: no server-side logic, it reads both chains from the browser. So it ships as files, either as an assets-only Cloudflare Worker (`web/wrangler.jsonc`, no `main`) — live at `verdikt-web.denis-perov.workers.dev` — or from nginx via `web/Dockerfile` + `docker-compose.yml` at the root. The Dockerfile builds from the repo root because the pnpm workspace spans it, and `.dockerignore` excludes every `.env` at any depth so an image takes its config from build args alone.

`proxy` is a Cloudflare Worker too (`proxy/wrangler.jsonc`), but not a static one: it has server-side secrets (`CRE_TRIGGER_PRIVATE_KEY`, `CRE_CALLBACK_TOKEN`) that must never reach a browser bundle the way `web`'s `VITE_` vars deliberately do, so local dev reads them from `proxy/.dev.vars` (gitignored, not `web/.env.local`'s pattern) and a real deployment sets them with `wrangler secret put`. It serves `*.verdikt.bond/*` through the route in `proxy/wrangler.jsonc` — the zone and its wildcard CNAME are live (#27) — and keeps `workers_dev` pinned on, because `CRE_CALLBACK_URL` points at the workers.dev hostname and a plain deploy without that field silently disables it.

The proxy's pending-callback rendezvous (`proxy/src/verification.js`'s trigger waits, `/internal/verification-callback` settles it) is one `PendingVerification` Durable Object per `requestId` (`proxy/src/pending-do.js`), addressed by `idFromName` so the trigger's `/wait` and the callback's `/settle` always reach the same instance regardless of which isolate handled either request. An in-process `Map` would be safe on a long-lived Node process and is not on Workers, where two HTTP requests are not guaranteed to land on the same isolate. `verification.js` itself does not know the difference — the DO-backed registry implements the same `PendingRegistry` shape as the in-memory one used outside Workers.

`runner` is the third deployable: a small Node service (`runner/`, run as a Docker container behind `cre.verdikt.bond`) that stands in for Chainlink's gateway while deploy access is closed. It verifies the proxy's trigger JWT and forwards `params.input` to a long-lived `cre workflow simulate verify --listen` child; the workflow posts its result straight to the proxy's callback, so the runner never sees a verdict. The same container runs `bin/publish-scores.sh` hourly — the only place the aggregate's cron actually fires — and reads the scores back afterwards, because the forwarder mines a receiver revert as success. `runner/README.md` has the env table and the Dokploy job.

The dashboard's config is `web/.env.local`, **not** the root `.env`: Vite reads env files only from its own root, which is `web/`. `web/.env.example` is the template. Two consequences that are easy to get wrong:

- **They are read at build time, never at run time.** Vite inlines them, so a deployed Worker or a running container cannot be repointed at another chain without rebuilding. Unset, `web/src/source.js` serves seeded demo data rather than an empty marketplace.
- **Everything `VITE_`-prefixed is public**, inlined into the shipped bundle. So the browser is the RPC client, and the endpoint must send CORS headers for the page's origin — the Alchemy app allowlists `localhost:5173`, `localhost:4173` and the workers.dev origin. A key that is not origin-restricted does not belong here; non-prefixed vars in the root `.env` are never exposed.

Foundry installs to `~/.foundry/bin` and its installer writes the `PATH` line to `~/.profile`, which zsh does not read. Use the absolute path or add it to `~/.zshrc`.

`pnpm demo` runs the whole registry loop against a throwaway anvil in seconds and asserts the refund arithmetic rather than narrating it. It is the fastest check that a contract change has not broken the accounting.

`node scripts/pay-x402.mjs <url>` signs a real x402 payment from the live challenge; `--send` spends. `pnpm onboard` mints and configures one `<slug>.verdikt.eth`.

## Architecture

### Two chains, each for one reason

**Arc** holds the registry, escrow, verdicts, refunds — and the x402 payment itself. USDC is Arc's native gas token, so value moves as `msg.value`, not ERC-20 transfers: no `approve`/`transferFrom`, no token address. Payment, bond, and refund are the same asset on the same chain, which is what removes any cross-chain correlation between the leg an agent paid on and the leg it is refunded on.

**Ethereum Sepolia** holds ENS. The SLA lives *only* as the `sla` text record on `<slug>.verdikt.eth` — there is no SLA field on Arc and no `setSLA`. ENSv2's Permissioned Resolver is chosen over v1 specifically for per-key access control: the provider is scoped to write `sla`, the CRE signer to `conformance`/`availability`, and cross-writes revert. Spike A confirmed that ACL enforces on Sepolia, and also that it has two bypasses the role bitmap must close: never grant a provider `ROLE_SET_RESOLVER` on its own subname, and grant per-key with `authorizeTextRoles`, never name-wide with `authorizeNameRoles`.

One slug is reused as three identifiers: the Arc `serviceId` (`keccak256`), the `<slug>.verdikt.bond` route, and the `<slug>.verdikt.eth` subname.

### Request path

The proxy branches on the payment header — `PAYMENT-SIGNATURE` (x402 v2) or `X-PAYMENT` (v1), checked in that order, because a real v2 provider sends only the new name. Without one, plain passthrough: the provider returns its own 402 challenge unchanged, and the proxy verifies nothing about it. It does not compare the challenge's `payTo` against the ENS `address` record (issue #39): the trust anchor is the service's registered `url` — bound to the slug's bond via `checkOwnership` — and an upstream that authors the challenge can declare whatever `payTo` it likes regardless of what ENS pins, so the check would be theater, and it would false-positive on any provider whose payout address legitimately rotates.

With a payment header present, the proxy first re-fetches the provider's 402 so `decodePayment` has the challenge's `accepts` (the header names its scheme but not its asset), verifies the payer, and only then triggers the confidential workflow, which replays the payment from inside the enclave, evaluates the response, writes the verdict to Arc, and returns the payload for the proxy to relay. A 402 on that replay writes nothing (see the invariants).

The agent signs its own payment. Verdikt holds no wallet on the payment leg.

### Two CRE workflows, deliberately separate

Per-request (confidential, TEE) touches real response bodies and triggers refunds. Hourly (plain, cron) only reads public `VerdictWritten` events to compute the trailing-window ratios and write them to ENS; it makes no Arc write and settles no refund. Merging them would make the aggregate depend on traffic timing and put non-confidential logic in the TEE.

**The window is temporarily one day, not the seven `Specification.md` §1 specifies.** `WINDOW_SECONDS` in `cre/lib/reputation.js` was cut for the hackathon demo: it is both the analysis period and the block range fetched, and one day is 17 chunked `eth_getLogs` calls per run against 115. The spec is unchanged and the deviation is deliberate — `grep -rn 'TEMPORARY (demo window)'` is the revert list. The `ServiceRegistered` scan is *not* windowed and must not be, or the marketplace empties.

## Invariants that are easy to break

A verdict is final with no dispute layer, so these are correctness, not style:

- **Refund is capped at `min(FIXED_REFUND, paidAmount, remaining deposit)`** — never a penalty on top. A refund larger than the payment makes induced-failure griefing profitable with no arbitration to fall back on.
- **`setVerdict` books `owed[payer]`, sends nothing.** Pushing value would let a payer address that rejects transfers revert the transaction and erase its own FAIL verdict — a provider farming its own service through a reverting contract could hold a spotless conformance ratio while failing real calls.
- **A 4xx in the status-only fallback writes no verdict at all.** A 4xx is usually the provider correctly rejecting a malformed request; scoring it as failure lets an agent farm refunds with deliberate garbage.
- **A 402 on the replay writes no verdict in *either* mode.** The provider is saying it was not paid, so there is no delivered call to judge. This is the anchor for the payer's side, and the reason `decodePayment` does **not** compare the signed recipient against the challenge's `payTo`: that comparison never stopped the attack it looked like it stopped (sign to the right `payTo` from an empty account, let settlement fail, collect on the 402), and it makes a provider that mints a single-use payout address per challenge unpayable. A refund can only exist on a call the provider took payment for.
- **An empty aggregation window yields 1000, not 0.** A service with no traffic is presumed healthy. Getting this backwards brands every new listing as broken.
- **`evaluate` is pure.** No I/O, no clock, no network, no floating point. Latency is an input, never measured inside. Price comparison in integer minor units.
- **Outcome ordinals are mirrored** in `IVerdiktRegistry.Outcome` and `OUTCOME_ORDINAL` in `packages/sdk/registry.js`. Changing one without the other silently reclassifies a FAIL as a PASS.
- **`paidAmount` is a `bigint` in minor units** everywhere past `decodePayment`. That boundary is what kept the engine independent of the header format while Spike C was open, and it is why implementing `eip3009` touched one file.
- **A verdict's `failedClause` is `keccak256(clauseId)`, and a PASS stores the zero word.** The id is provider-authored and unbounded; a reader holds the SLA from ENS and matches (`matchFailedClause`). Four readings, all distinct: the clause id; `delivery`, the implicit clause matched *by name* because no SLA declares it; the zero word, meaning judgement fell back to status alone; and a non-zero hash matching nothing, meaning the provider has edited its SLA since. Flattening any pair of those loses the fact worth showing.
- **The observed value never goes on the chain.** It is a slice of a response the agent paid for. It reaches that agent on its own response (`x-verdikt-expected` / `-actual`), which is the one party entitled to it.
- **The payer a verdict books is the account actually debited.** Under `GatewayWalletBatched` that is the agent wallet's *backing EOA*, not the smart account, and it may never be able to transact on Arc. Do not "fix" the derivation to name a friendlier address — it names who paid; the claim path (`withdrawWithAuthorization`, relayable by anyone) is where that is solved.
- **`decodePayment` needs the challenge's `accepts`, and refuses without it.** The header names its scheme and network but not its asset, and the EIP-712 domain needs the asset as `verifyingContract`. Taking the domain from the header would let a payer sign something harmless elsewhere and replay it here.

## Two silent failures, and why they were silent

Both shipped green for days. Neither raised an error anywhere; both were caught only by a number that looked wrong.

- **The aggregate keeps its own copy of the registry's event signatures**, because a workflow bundles to WASM and cannot reach the SDK's ABI. That copy is the log filter's *topic*, not a decode hint: add a field to `VerdictWritten` and a stale copy matches nothing, the window comes back empty, and an empty window scores **1000**. So the symptom is every service reporting a perfect record. `cre/lib/workflow-abi.test.js` pins the copies together — keep them in step or that test fails, which is the point.
- **The KeystoneForwarder swallows a receiver revert and mines anyway.** `txStatus === SUCCESS` means the forwarder ran, never that the receiver wrote. A receiver deployment is therefore not finished when the deploy script returns: read the value back (`text(node, "conformance")`, `getVerdict`). Simulation forwarders are also **per-chain** — `0x6E9EE680…` on Arc, `0x15fC6ae9…` on Sepolia, unrelated contracts — and pinning the wrong one produces exactly this silence (CRE-8, CRE-10).

## Package boundaries

These are load-bearing, not organizational:

- **`packages/sdk/ens.js` is the only file that knows ENS exists.** Every read and write goes through it, returning one `ServiceRecord`. This exists so the unresolved ENSv2→v1 question touches one file instead of rippling through the CRE workflow, proxy, and dashboard. Do not import an ENS library anywhere else, and do not make two calls where one returns everything — `resolveServiceRecord` batches the four text keys and the address record into a single round trip.
- **`resolveServiceRecord` returns `sla` raw and unparsed.** Parsing belongs to `packages/sla`, so the ENS layer carries no SLA-schema knowledge.
- **`packages/sla` has no dependencies and must keep none** — it bundles into the CRE workflow. Hand-roll the JSON Schema subset rather than pulling ajv.
- **`proxy` must not depend on `@verdikt/sla`.** The proxy relays and never evaluates; if it needs the engine, something has crossed to the wrong side of the enclave boundary. This is why the discovery API is built but unwired: filtering on price or latency means reading SLA clauses. The rule caught it working as intended, so it is a decision rather than a bug — tracked as [#21](https://github.com/imajus/verdikt/issues/21), and `/services` answers 503 naming the reason until it is made.
- **Clause internals in `packages/sla` are private.** The stable seam is `evaluate` plus `SlaObservation` and `SlaEvaluation`.

## Conventions

JS with ESM throughout, not TypeScript. Types live in ambient `*.d.ts` files with no `export`; JSDoc annotations reference those ambient types rather than declaring their own.

Root-level config (`vitest.config.js`, `eslint.config.js`, `jsconfig.json`) is single and shared on purpose — per-package copies would be files parallel workstreams contend over. Node globals are pre-declared in the eslint config for the same reason.

Marketplace data is read straight off RPC logs with no subgraph, which is why `ServiceRegistered` emits the full slug: `keccak256` is one-way, so nothing else can map a `serviceId` back to a display name.
