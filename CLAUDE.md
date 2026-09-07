# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Verdikt is

A marketplace of x402-gated API services whose delivery is verified per call. A proxy sits between a paying agent and an x402 provider, verifies the response against the provider's own declared SLA inside a Chainlink CRE Confidential Workflow, writes a verdict on-chain, and auto-refunds from the provider's bonded deposit when the SLA isn't met. There is no dispute or arbitration step by design.

`docs/` is the specification and takes precedence over inference from code:

- `docs/Requirements.md` — problem, scope, non-goals, open risks
- `docs/Specification.md` — mechanics; sections are cited throughout the code as `spec §N`
- `docs/Tasks.md` — the phased build plan, ordered by risk

## Current state

The loop runs end to end on public testnets. `docs/walkthrough.md` is the tour, `docs/shot-list.md` the 3-minute cut, and `docs/evidence/` holds the transcripts — every number in them was read back off a chain.

- **Arc Testnet** — `VerdiktRegistry` at `0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af`, block 60860488. Two services bonded, three verdicts written through the real KeystoneForwarder, refunds credited and withdrawn.
- **Sepolia** — `verdikt.eth` with two subnames carrying real `sla`, `url` and `address` records, plus `conformance`/`availability` published by the hourly workflow through `VerdiktScoreWriter` at `0x542Cb024D71e0Cd0Ef40AB7603779C89895EFfAA`.
- Both CRE workflows run under `cre workflow simulate --broadcast`.

All three spikes have run. **A** (ENSv2) — `docs/spikes/A-ens-sepolia.md`. **B** (CRE) — `docs/spikes/cre.md`, findings CRE-1…CRE-10, several of which reshaped the contracts. **C** (`X-PAYMENT`) — the `exact`/`eip3009` scheme is implemented and a signature it produced settled on Base Sepolia; Circle's `GatewayWalletBatched` is unpublished and still refuses rather than guessing.

Three things are deliberately unfinished, each argued at its own task in `docs/Tasks.md`: a paid call end to end (the demo paywall advertises `eip3009`, then answers 402 to a payment the USDC contract itself accepts), production CRE enrollment (`cre whoami` → *Deploy Access: Not enabled*), and the recorded video.

## Commands

```bash
pnpm lint                        # eslint
pnpm typecheck                   # tsc --noEmit against jsconfig.json
pnpm test                        # vitest run
pnpm vitest run path/to.test.js  # single test file
pnpm vitest run -t "name"        # single test by name
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

`proxy` is a Cloudflare Worker too (`proxy/wrangler.jsonc`), but not a static one: it has server-side secrets (`CRE_TRIGGER_PRIVATE_KEY`, `CRE_CALLBACK_TOKEN`) that must never reach a browser bundle the way `web`'s `VITE_` vars deliberately do, so local dev reads them from `proxy/.dev.vars` (gitignored, not `web/.env.local`'s pattern) and a real deployment sets them with `wrangler secret put`. Deploys to `workers.dev` today; routing `*.verdikt.bond/*` to it needs the zone added to the Cloudflare account first (Tasks.md 0.6), which is an infra step, not a code change.

The proxy's pending-callback rendezvous (`proxy/src/verification.js`'s trigger waits, `/internal/verification-callback` settles it) used to be an in-process `Map` — safe on a long-lived Node process, unsafe on Workers, where two HTTP requests are not guaranteed to land on the same isolate. `proxy/src/pending-do.js` replaces it with one `PendingVerification` Durable Object per `requestId`, addressed by `idFromName` so the trigger's `/wait` and the callback's `/settle` always reach the same instance regardless of which isolate handled either request. `verification.js` itself does not know the difference — the DO-backed registry implements the same `PendingRegistry` shape as the in-memory one it replaces in production.

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

The proxy branches on `X-PAYMENT`. Without it, plain passthrough: the provider returns its 402 challenge, and the proxy compares the challenge's `payTo` against the ENS address record, blocking on mismatch so the agent never signs against a spoofed address. This check runs *outside* the enclave — a 402 challenge is public, so it needs no attestation.

With `X-PAYMENT` present, the confidential workflow replays the payment from inside the enclave, evaluates the response, writes the verdict to Arc, and returns the payload for the proxy to relay.

The agent signs its own payment. Verdikt holds no wallet on the payment leg.

### Two CRE workflows, deliberately separate

Per-request (confidential, TEE) touches real response bodies and triggers refunds. Hourly (plain, cron) only reads public `VerdictWritten` events to compute the trailing-7-day ratios and write them to ENS; it makes no Arc write and settles no refund. Merging them would make the aggregate depend on traffic timing and put non-confidential logic in the TEE.

## Invariants that are easy to break

A verdict is final with no dispute layer, so these are correctness, not style:

- **Refund is capped at `min(FIXED_REFUND, paidAmount, remaining deposit)`** — never a penalty on top. A refund larger than the payment makes induced-failure griefing profitable with no arbitration to fall back on.
- **`setVerdict` books `owed[payer]`, sends nothing.** Pushing value would let a payer address that rejects transfers revert the transaction and erase its own FAIL verdict — a provider farming its own service through a reverting contract could hold a spotless conformance ratio while failing real calls.
- **A 4xx in the status-only fallback writes no verdict at all.** A 4xx is usually the provider correctly rejecting a malformed request; scoring it as failure lets an agent farm refunds with deliberate garbage.
- **An empty aggregation window yields 1000, not 0.** A service with no traffic is presumed healthy. Getting this backwards brands every new listing as broken.
- **`evaluate` is pure.** No I/O, no clock, no network, no floating point. Latency is an input, never measured inside. Price comparison in integer minor units.
- **Outcome ordinals are mirrored** in `IVerdiktRegistry.Outcome` and `OUTCOME_ORDINAL` in `packages/sdk/registry.js`. Changing one without the other silently reclassifies a FAIL as a PASS.
- **`paidAmount` is a `bigint` in minor units** everywhere past `decodePayment`. That boundary is what kept the engine independent of the header format while Spike C was open, and it is why implementing `eip3009` touched one file.
- **A verdict's `failedClause` is `keccak256(clauseId)`, and a PASS stores the zero word.** The id is provider-authored and unbounded; a reader holds the SLA from ENS and matches (`matchFailedClause`). Four readings, all distinct: the clause id; `delivery`, the implicit clause matched *by name* because no SLA declares it; the zero word, meaning judgement fell back to status alone; and a non-zero hash matching nothing, meaning the provider has edited its SLA since. Flattening any pair of those loses the fact worth showing.
- **The observed value never goes on the chain.** It is a slice of a response the agent paid for. It reaches that agent on its own response (`x-verdikt-expected` / `-actual`), which is the one party entitled to it.
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
