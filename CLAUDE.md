# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Verdikt is

A marketplace of x402-gated API services whose delivery is verified per call. A proxy sits between a paying agent and an x402 provider, verifies the response against the provider's own declared SLA inside a Chainlink CRE Confidential Workflow, writes a verdict on-chain, and auto-refunds from the provider's bonded deposit when the SLA isn't met. There is no dispute or arbitration step by design.

`docs/` is the specification and takes precedence over inference from code:

- `docs/Requirements.md` — problem, scope, non-goals, open risks
- `docs/Specification.md` — mechanics; sections are cited throughout the code as `spec §N`
- `docs/Tasks.md` — the phased build plan, ordered by risk

## Current state

Wave 0 (seams) plus the three spikes. Most JS functions still throw `NOT_IMPLEMENTED` and `IVerdiktRegistry.sol` is an interface with no bodies. What is real: the enum mappings in `packages/sdk/registry.js` (they *are* the seam), all of `packages/sdk/payment.js` plus `fixtures/x402.js`, and `cre/spike/` (Spike B's workflow, a spike and not the shipping one).

All three spikes in `docs/Tasks.md` §0.2–0.4 have run and their gates passed: Spike A (ENSv2 on Sepolia) — `pnpm spike:ens`, `docs/spikes/A-ens-sepolia.md` — Spike B (Chainlink CRE) — `cre/spike/`, `docs/spikes/cre.md`, with `cre workflow simulate` still unrun because it needs a browser login — and Spike C (`X-PAYMENT` decoding) — `pnpm spike:payment`, `docs/spikes/C-x402-payment.md`.

Three results from Spike C change what downstream code must do:

- The payer and amount **are** cryptographically bound (fields of the signed EIP-3009 struct), so the settlement-receipt fallback is not needed for identity. `decodePayment` recovers the signer and returns nothing on mismatch.
- A signed authorization is an **intent to pay, not a payment**, and stays valid ~7 days. The enclave must confirm the settlement receipt before writing any verdict — including a `DOWN`, which is otherwise the exact shape of a refund farm. Not built yet; Phase 3 owes it.
- `GatewayWalletBatched` is an EIP-712 domain name, not a scheme. The scheme string is `exact`, and one decoder handles vanilla x402 too.

## Commands

```bash
pnpm lint                        # eslint
pnpm typecheck                   # tsc --noEmit against jsconfig.json
pnpm test                        # vitest run
pnpm vitest run path/to.test.js  # single test file
pnpm vitest run -t "name"        # single test by name
pnpm spike:ens                   # Spike A's evidence (forked Sepolia)
pnpm spike:payment               # Spike C's evidence; --live also hits Arc RPC
```

`pnpm spike:payment` regenerates `fixtures/x402.js`. It is deterministic, so a
dirty tree after running it means something drifted.

```bash
cd contracts
forge fmt --check                # CI enforces this
forge build
forge test
forge test --match-test testRefund     # single test
forge test --match-contract Registry   # single contract
```

Foundry installs to `~/.foundry/bin` and its installer writes the `PATH` line to `~/.profile`, which zsh does not read. Use the absolute path or add it to `~/.zshrc`.

`vitest.config.js` no longer sets `passWithNoTests` — Spike C landed the first real tests, so an empty suite is a failure again.

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
- **`paidAmount` is a `bigint` in minor units** everywhere past `decodePayment`. That boundary is what keeps the engine independent of the header's wire format.
- **The paid amount is not in the deposit's units.** x402 pays the USDC ERC-20 (6 decimals); the bond, refunds and `owed` are Arc native USDC (18). Anything comparing the two goes through `toArcNativeUnits` first — unscaled, `paidAmount` wins `min(FIXED_REFUND, paidAmount, deposit)` every time and refunds a trillionth of the payment.
- **A verdict requires a confirmed settlement.** `decodePayment` succeeding only means the agent signed; it does not mean money moved.

## Package boundaries

These are load-bearing, not organizational:

- **`packages/sdk/payment.js` is the only file that decodes x402.** It is also the only place the payer/amount binding is checked, so nothing downstream should re-read `authorization.from` off a header itself. `fixtures/x402.js` is generated by `scripts/spike-payment.mjs`; edit the script, re-run it, commit both.
- **`packages/sdk/ens.js` is the only file that knows ENS exists.** Every read and write goes through it, returning one `ServiceRecord`. This exists so the unresolved ENSv2→v1 question touches one file instead of rippling through the CRE workflow, proxy, and dashboard. Do not import an ENS library anywhere else, and do not make two calls where one returns all four records.
- **`resolveServiceRecord` returns `sla` raw and unparsed.** Parsing belongs to `packages/sla`, so the ENS layer carries no SLA-schema knowledge.
- **`packages/sla` has no dependencies and must keep none** — it bundles into the CRE workflow. Hand-roll the JSON Schema subset rather than pulling ajv.
- **`proxy` must not depend on `@verdikt/sla`.** The proxy relays and never evaluates; if it needs the engine, something has crossed to the wrong side of the enclave boundary.
- **Clause internals in `packages/sla` are private.** The stable seam is `evaluate` plus `SlaObservation` and `SlaEvaluation`.

## Conventions

JS with ESM throughout, not TypeScript. Types live in ambient `*.d.ts` files with no `export`; JSDoc annotations reference those ambient types rather than declaring their own.

Root-level config (`vitest.config.js`, `eslint.config.js`, `jsconfig.json`) is single and shared on purpose — per-package copies would be files parallel workstreams contend over. Node globals are pre-declared in the eslint config for the same reason.

Marketplace data is read straight off RPC logs with no subgraph, which is why `ServiceRegistered` emits the full slug: `keccak256` is one-way, so nothing else can map a `serviceId` back to a display name.
