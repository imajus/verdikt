# Verdikt

> A marketplace of x402 API services whose delivery is verified per call, with
> refunds enforced on-chain and no dispute layer.

x402 has no verification layer. The facilitator settles payment; the directory
is self-reported. Neither checks that a paid-for call delivered what the
provider advertised.

Verdikt puts a proxy between a paying agent and an x402 provider. The proxy
hands the call to a Chainlink CRE Confidential Workflow, which replays the
payment from inside a TEE, evaluates the response against the provider's own
declared SLA, writes a `PASS`/`FAIL`/`DOWN` verdict to Arc, and auto-refunds the
agent from the provider's bonded deposit when the SLA is not met. There is no
challenge process and no arbiter: the verdict is a deterministic function of
(SLA, observed response), and the code computing it is attested and published.

## Table of Contents

- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Layout](#layout)
- [What is real, and what is not](#what-is-real-and-what-is-not)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Contributing](#contributing)
- [License](#license)

## How it works

```
agent ──no X-PAYMENT──► proxy ──► provider's 402 challenge
                          │
                          └─ compares the challenge's payTo against the address
                             record on <slug>.verdikt.eth, and BLOCKS on a
                             mismatch. This is the one check that must happen
                             before the fact: a payment to a spoofed address
                             leaves no bond to reclaim from.

agent ──with X-PAYMENT─► proxy ──► CRE Confidential Workflow (TEE)
                                     ├─ replays the payment against the provider
                                     ├─ evaluates the response vs the SLA
                                     ├─ writes the verdict to Arc as a
                                     │  DON-signed report
                                     └─ returns the payload to relay back

hourly, separately ────► CRE cron workflow (no TEE)
                           reads public VerdictWritten events, computes the
                           trailing-7-day conformance and availability ratios,
                           publishes them to ENS
```

Two chains, each for one reason:

- **Arc** holds the registry, escrow, verdicts, refunds — and the x402 payment.
  USDC is Arc's native gas token, so payment, bond and refund are the same asset
  on the same chain, and a refund needs no cross-chain correlation.
- **Ethereum Sepolia** holds ENS. The SLA lives *only* as the `sla` text record
  on `<slug>.verdikt.eth`. ENSv2's Permissioned Resolver is used for its per-key
  access control: the provider is scoped to `sla` and `url`, the CRE side to
  `conformance` and `availability`, and cross-writes revert.

One slug is three identifiers: the Arc `serviceId` (`keccak256`), the
`<slug>.verdikt.bond` route, and the `<slug>.verdikt.eth` subname.

## Install

Requires Node 22+, [pnpm](https://pnpm.io), and [Foundry](https://getfoundry.sh)
(`anvil`, `forge`). The CRE workflows additionally need [bun](https://bun.sh)
and the [CRE CLI](https://docs.chain.link/cre).

```bash
pnpm install
cd contracts && forge build
cp .env.example .env      # then fill in what you have
```

## Usage

```bash
pnpm test            # 209 tests: engine, SDK, proxy, workflow logic, dashboard
pnpm lint
pnpm typecheck       # tsc against JSDoc — the repo is JS, not TypeScript
pnpm demo            # the whole loop end to end, on a local chain

cd contracts && forge test    # 47 tests: registry and score-writer
cd web && pnpm dev            # the marketplace dashboard
cd proxy && pnpm dev          # the x402 relay
```

`pnpm demo` deploys the registry to a throwaway `anvil`, registers an honest
service and a violating twin, drives the twin's bond to zero through ten failed
calls, and has the agent withdraw — printing each step. It asserts the refund
cap and the withdrawal amount rather than only narrating them.

The CRE workflows compile and simulate:

```bash
cd cre/workflows/verify && bun install && bun run compile
cd cre/workflows && cre workflow simulate verify --listen
```

Captured runs are in [`docs/evidence/`](docs/evidence): a simulate run including
the TEE banner, and the enclave-to-proxy callback round trip.

## Layout

| Path | What it is |
|---|---|
| `packages/sla` | The evaluation engine. Pure, dependency-free, bundles into the enclave. |
| `packages/sdk` | The only files that know an ABI or that ENS exists. |
| `contracts` | `VerdiktRegistry` on Arc, `VerdiktScoreWriter` on Sepolia. |
| `cre/lib` | Everything the workflows decide, as plain JS under vitest. |
| `cre/workflows` | The two CRE workflows — capability plumbing around `cre/lib`. |
| `proxy` | The x402 relay. Holds no wallet and never evaluates. |
| `web` | The marketplace dashboard. |
| `deployments` | Verdikt's own deployed addresses, per network. Checked in: they are public and identical everywhere. |
| `docs` | The specification, and the spikes that reshaped it. |

Start with the [walkthrough](docs/walkthrough.md) — the whole loop, on a public
chain, with real commands and real output.

`docs/` takes precedence over inference from code:
[Requirements](docs/Requirements.md) ·
[Specification](docs/Specification.md) ·
[Tasks](docs/Tasks.md) ·
[Spike A: ENSv2](docs/spikes/A-ens-sepolia.md) ·
[Spike B: CRE](docs/spikes/cre.md)

## What is real, and what is not

Stated plainly, because a verification product that overstates its own
verification would be self-refuting.

**Real, and checked:**

- The evaluation engine, the registry accounting, the proxy's request path and
  the dashboard's data layer all have tests, including the adversarial cases:
  a payer that rejects transfers, a reentrant withdrawal, a spoofed `payTo`, a
  provider URL aimed at link-local space.
- ENSv2's per-key access control enforces on Sepolia — asserted against the live
  contracts, including the negative case (Spike A).
- Both CRE workflows compile to WASM with `@verdikt/sla` bundled in, and the
  per-request one runs green under `cre workflow simulate` in confidential mode.
- The paid leg's round trip works: the enclave pushes its finished verification
  back to the proxy, which relays the provider's payload to the agent. Captured
  in [`docs/evidence/cre-callback-roundtrip.log`](docs/evidence/cre-callback-roundtrip.log) —
  Chainlink documents no way to *read* an execution's result, so pushing is the
  mechanism (spike finding CRE-9).

**Live on a public chain:**

- `VerdiktRegistry` on Arc Testnet at `0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af`,
  `VerdiktScoreWriter` on Sepolia at `0x542Cb024D71e0Cd0Ef40AB7603779C89895EFfAA`,
  and `weather` / `weather-lite` registered with 10 USDC bonds and their own
  `verdikt.eth` subnames.
- Three verdicts written by DON-signed reports through the real
  KeystoneForwarder — a PASS, and two FAILs that each name the clause that
  broke. One broke `price-band` and refunded the full 1 USDC; the other broke
  `current-weather-shape` and refunded 0.0025 USDC, because the cap is what was
  actually paid.
- The proxy relaying a real 402 from a live Proceeds paywall with its `payTo`
  verified, and blocking the same call once the address record was repointed.
- The hourly aggregate computing `weather=500/1000 weather-lite=0/1000` from
  those events and publishing both to ENS, where they can be read back off
  `<slug>.verdikt.eth`. All of it in [`docs/evidence/`](docs/evidence).

**Simulated or blocked, and why:**

- **Attestation is simulated.** CRE production enrollment is private beta
  (`cre whoami` → *Deploy Access: Not enabled*), so both receivers are pinned to
  the simulation forwarder. The simulator says it plainly: *"The simulator is not
  a real TEE."*
- **`decodePayment` handles half of x402, and refuses the other half.** The
  `exact`/`eip3009` scheme is implemented and *verified* — the payer is
  recovered from an ERC-3009 signature, so swapping the payer or inflating the
  amount invalidates it, which the tests demonstrate by doing exactly that to
  headers they signed. Circle's `GatewayWalletBatched` — the option the demo
  paywall offers on Arc — is not published, so it refuses rather than guessing,
  unless `VERDIKT_ALLOW_STUB_PAYMENT=true` is set explicitly. The verdicts above
  therefore carry a fixture payer.
- **No paid call has been verified end to end.** The header names its scheme but
  not its asset, and the EIP-712 domain needs one, so verification requires the
  challenge that payment answers — which the proxy does not currently keep.
- **The KeystoneForwarder metadata offsets are confirmed against the SDK's own
  parser, but not against a live delivery.** Every offset matches
  `REPORT_METADATA_OFFSETS` in `@chainlink/cre-sdk`. What remains untested is a
  real forwarder call, so the residual risk is a header version change.
- **Per-verdict clause detail is not on the dashboard.** Clause results never
  reach the chain; the detail view shows what a service promised beside what it
  delivered. [Tasks §5.2](docs/Tasks.md) records what closing it would take.

## Design decisions worth knowing

- **No dispute layer, by choice.** x402 responses are pay-gated, so there is no
  free public source of truth a challenger could re-derive a claim against. The
  bond substitutes for re-derivation, which is what makes the refund cap
  load-bearing: a refund larger than the payment would make inducing failures
  profitable, with nothing to appeal to.
- **A verdict books a credit; it never sends value.** Pushing value would let a
  payer address that rejects transfers revert the call and erase its own `FAIL` —
  a provider farming its own service through a reverting contract could hold a
  spotless record while failing real calls.
- **A service with no traffic scores 1000, not 0.** Verdikt measures what agents
  actually bought, not what a synthetic prober would have seen. Getting this
  backwards brands every new listing as broken.
- **A 4xx in the status-only fallback writes no verdict at all.** A 4xx is
  usually the provider correctly rejecting a malformed request; scoring it as
  failure would let an agent farm refunds with deliberate garbage.
- **The naming layer is on a testnet because ENSv2 has no mainnet deployment.**
  A deployment constraint, not a shortcut.

## Contributing

This is a hackathon build (ETHOnline 2026). Issues and PRs welcome, but
[`docs/Tasks.md`](docs/Tasks.md) is the plan of record and records the decisions
that are not derivable from the code.

## License

MIT
