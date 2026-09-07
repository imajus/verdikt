# Verdikt — walkthrough

Every command here has been run, and every output is real. Addresses are live on
Arc Testnet and Ethereum Sepolia; the transcripts are in
[`evidence/`](./evidence).

**This is not the recorded video.** A screen recording still needs a human —
Tasks.md 6.3 stays open for that. What this is, is the script for one: the same
order, with the commands and the numbers to expect.

## What is deployed

| | |
|---|---|
| `VerdiktRegistry` | [`0xa22440c1ae6ce9178b3341ee19b55b881eaeff76`](https://explorer.testnet.arc.network/address/0xa22440c1ae6ce9178b3341ee19b55b881eaeff76) on Arc Testnet, block 60839524 |
| `VerdiktScoreWriter` | `0xbD4A99AE4f0534F84089dE2a21edb8DBfCaE0Deb` on Sepolia |
| Namespace | `verdikt.eth` on Sepolia ENSv2, with `weather` and `weather-lite` subnames |
| Provider | a live [Proceeds](https://myproceeds.xyz) x402 paywall, paying to `0x5c33f235…16505` |

Both receivers are pinned to the **CRE simulation** forwarder and the
`workflowOwner` simulation sends. Production enrollment is private beta
(`cre whoami` → *Deploy Access: Not enabled*), so that is what lets a workflow
write verdicts here today. Both values are immutable; production is a redeploy.

## 1. A service registers and posts a bond

```bash
cast send $REGISTRY 'register(string)' weather --value 10000000000000000000 \
  --private-key $PROVIDER_PRIVATE_KEY --rpc-url $ARC_RPC_URL
```

10 USDC, as `msg.value` — USDC is Arc's gas token, so the bond, the payment and
the refund are one asset on one chain. `serviceId` is `keccak256("weather")`,
and the same slug is the `weather.verdikt.bond` route and the
`weather.verdikt.eth` subname.

## 2. It publishes what it promises

```bash
pnpm onboard -- --send --slug weather \
  --url https://myproceeds.xyz/api/x402/pay/… \
  --pay-to 0x5c33f23555313256b71f2b0a7ea1938425516505 \
  --sla "$(cat fixtures/sla/honest.json)"
```

This mints the subname and grants two disjoint sets of keys: the provider may
write `sla` and `url`, the score writer may write `conformance` and
`availability`, and neither can write the other's. That per-key ACL is the whole
reason for ENSv2 over v1 — Spike A asserts the cross-write reverts against the
live contracts.

The provider gets the subname token and **no registry roles**. One with
`ROLE_SET_RESOLVER` could repoint its own name at a resolver it controls and
write its own scores.

## 3. An agent calls, and the proxy checks where the money goes

```bash
$ curl -sD - http://localhost:8403/weather | grep -iE '^HTTP|x-verdikt'
HTTP/1.1 402 Payment Required
x-verdikt-pay-to-verified: true
```

The proxy relayed to the provider, got its real 402, resolved
`weather.verdikt.eth`'s address record on Sepolia, and compared it against
**every** payment option the challenge offers — three of them, on Arc and Base.
Only then did it pass the challenge on.

Repoint that record and the same call is refused:

```bash
$ curl -sD - http://localhost:8403/weather-lite | grep -iE '^HTTP|x-verdikt-block'
HTTP/1.1 502 Bad Gateway
x-verdikt-block: pay_to_mismatch
```

The body names both addresses for an operator but carries no `accepts` at all,
so no signable challenge reaches the agent. This is the one Verdikt check that
must happen *before* the fact: a payment to a spoofed address never touches the
bonded service, so there is nothing to reclaim it from. Full transcript in
[`evidence/payto-check-live.log`](./evidence/payto-check-live.log).

## 4. The enclave judges the paid call

```bash
cd cre/workflows && cre workflow simulate verify --broadcast --listen
curl -X POST http://localhost:2000/trigger -d '{"input":{…,"sla":"…"}}'
```

The handler runs in confidential mode — the run prints the AWS Nitro banner —
makes the paid call from inside the enclave, evaluates the response against the
provider's own SLA, and hands the DON a report to sign. The KeystoneForwarder
verifies the signatures and calls `onReport`.

Two verdicts are on Arc from this:

```
PASS  0x…0301  weather       status-only (no SLA published at the time)
FAIL  0x…0401  weather-lite  schema and latency clauses both broke
```

The workflow also pushes the provider's response back to the proxy, which is how
the agent gets what it paid for — the trigger response does not carry it and
nothing documents a way to read an execution's result
([`evidence/cre-callback-roundtrip.log`](./evidence/cre-callback-roundtrip.log)).

## 5. The refund settles itself

```bash
$ cast call $REGISTRY 'getVerdict(bytes32)(...)' 0x…0401
(0x899bec1a…, 1, 0x1111…1111, 2500000, 1000000000000000000, 1788746222)
$ cast call $REGISTRY 'getOwed(address)(uint256)' 0x1111…1111
1000000000000000000
```

The agent paid 2 500 000 minor units (2.5 USDC) and is credited 1 USDC — the
fixed refund, since `min(FIXED_REFUND, paidAmount, remaining deposit)` picks it.
The bond went from 10 to 9 USDC.

Three things in that one line are load-bearing:

- **The cap.** A refund can never exceed what was paid, so inducing failures is
  break-even-minus-gas. With no dispute layer, anything larger makes griefing a
  strategy.
- **The conversion.** `paidAmount` is the 6-decimal ERC-20 view; the bond is
  `msg.value`, 18 decimals. They differ by 1e12, and the registry converts.
- **It is a credit, not a transfer.** `withdraw()` collects it. Pushing value
  would let a payer that rejects transfers revert the call and erase its own
  FAIL.

## 6. The marketplace shows the record

```bash
cd web && VITE_ARC_RPC_URL=… pnpm dev
```

Both services, their bonds, their verdicts, the refund, and each SLA rendered
from ENS beside what the service actually delivered. Scores read `—` because the
hourly run has not published these listings yet — a dash, never a zero, because
a service nobody has called is presumed healthy.

## 7. The hourly aggregate

```bash
cd cre/workflows && cre workflow simulate aggregate
```

```
window 604800s ending 1788747464: weather=1000/1000 weather-lite=0/1000
```

Computed from the same two `VerdictWritten` events: conformance is
`PASS / (PASS + FAIL)`, availability is `(PASS + FAIL) / all`. It reads only
public events, needs no enclave, writes no verdict and settles no refund.

> Swap the schedule to `*/15 * * * * *` first. The simulator honours the cron, so
> the production hourly config sits silently until the top of the hour and looks
> exactly like a hang.

## What this does not show

- **A real x402 payment.** Spike C never ran: `GatewayWalletBatched` debits a
  pre-funded Circle Gateway balance, which we do not have. `decodePayment` is
  still a fixture stub and *refuses to run* without an explicit opt-in, so it
  cannot ship unnoticed. The verdicts above carry a fixture payer.
- **A deployed workflow.** Simulation, not production enrollment.
- **A real attested enclave.** The simulator says so itself: *"The simulator is
  not a real TEE, and is meant to debug."*
- **Per-verdict clause detail, on *these* verdicts.** A verdict now names the
  clause that broke, and the dashboard resolves it — but the registry above was
  deployed before that field existed, so the two verdicts on it carry no clause.
  `pnpm demo` shows the round trip locally. The observed value stays off-chain
  by design: it is a slice of a paid response, and a public chain would publish
  it to everyone.

Everything else above is on a public chain and can be re-read from it.
