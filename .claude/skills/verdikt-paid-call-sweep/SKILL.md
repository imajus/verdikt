---
name: verdikt-paid-call-sweep
description: >-
  Enumerate the services currently registered in the Verdikt registry on Arc, make a real paid
  x402 call to each one through its verdikt.bond proxy URL using the Circle Agent Wallet, then read
  the verdicts back off Arc to confirm each call was judged. Use this whenever the task involves
  listing registered/live/active Verdikt services, exercising the paid leg end to end, smoke-testing
  the proxy or the confidential workflow with real money, reproducing the demo traffic, or answering
  "does a paid call actually work / did it write a verdict / did it refund" — and also for a paid
  call to a single service, since the per-service mechanics are the same. Reach for this before
  hand-rolling curl or scripts/pay-x402.mjs against these endpoints: real USDC moves per call and
  several of the traps here cost money rather than just failing.
---

# Verdikt paid-call sweep

This drives the loop the marketplace exists to demonstrate: an agent pays a real x402 provider
through the Verdikt proxy, the confidential workflow judges the response against the provider's
own SLA, and Arc ends up holding a verdict — plus a refund out of the provider's bond when the
SLA was not met.

Every call spends real USDC on a real third-party provider, and several failure modes charge you
anyway. So the ordering matters: enumerate, read each challenge for free, *then* pay.

**Discover everything at run time.** The registry changes — services get registered and retired,
prices move, providers change their schemas and their accepted networks. Nothing about a
particular service belongs in your plan before you have read it off the chain and out of the live
402. If you catch yourself recalling what a slug costs or what payload it took, re-read it instead.

## Before you start

```bash
circle wallet status                                     # VALID on mainnet, else use-agent-wallet
circle wallet list --chain BASE --type agent --output json
circle wallet balance  --chain BASE --address <addr> --output json   # on-chain ("vanilla")
circle gateway balance --chain BASE --address <addr> --output json   # Circle Gateway ledger
```

Two things to settle here, because both have bitten this workflow:

- **There may be more than one agent wallet, and only one funded.** Check each before picking.
  `--address` and `--chain` are both required on the balance commands.
- **Those are two separate ledgers, and a sweep spends from both.** An option advertising
  `extra.name: GatewayWalletBatched` is paid from the Gateway ledger; a plain `exact` option is
  paid from the wallet's own on-chain balance. Write down the starting number for each — that is
  what later lets you tell a charge from a non-charge, which is the only reliable way to read an
  ambiguous failure.

The sweep also reads Arc. Set `ARC_RPC_URL` in the repo-root `.env` (the scripts load it
themselves) — Arc's public RPC refuses a full log scan partway through with
`-32005 rate limit exceeded`, and that fallback path takes minutes instead of seconds.

## Step 1 — What is registered right now

```bash
node .claude/skills/verdikt-paid-call-sweep/scripts/list-services.mjs          # listed only
node .claude/skills/verdikt-paid-call-sweep/scripts/list-services.mjs --all    # + deregistered
```

Do not take the service list from `docs/` or `CLAUDE.md`. It goes stale — that is not
hypothetical, it is how this workflow started: the docs described an empty marketplace while nine
services were live on chain. The registry is the only source of truth, and the slug is the whole
identifier: the Arc `serviceId`, the `<slug>.verdikt.bond` route, and the `<slug>.verdikt.eth`
subname all at once.

`DEREGISTERED` rows are excluded by default and should stay out of a sweep — the bond is returned,
the slug can never be re-registered, and the proxy answers `service_not_active`.

Note each provider's current bond. It is the baseline for the refund cross-check in step 4.

## Step 2 — Read every challenge before paying for anything

```bash
node .claude/skills/verdikt-paid-call-sweep/scripts/challenge.mjs --all        # whole roster
node .claude/skills/verdikt-paid-call-sweep/scripts/challenge.mjs <slug>       # one service
node .claude/skills/verdikt-paid-call-sweep/scripts/challenge.mjs <slug> --raw # whole document
```

A 402 is what an unpaid request is *supposed* to get, so this costs nothing and is worth running
across the whole roster first. It answers the three questions that decide whether and how you can
pay each service:

**Can it be paid at all?** Only `eip155:` options are reachable — the Circle agent wallet is
EVM-only. A service offering nothing else is a hard stop, reported rather than worked around.

**Which ledger does it draw on?** `GatewayWalletBatched` means Gateway; anything else means the
on-chain balance.

**What must the request body contain?** Most providers publish a real JSON Schema inside the
challenge, and the script prints its `required` and optional fields directly. Build the payload
from that: satisfy every required field, and skip the optional ones unless the user asked for
something specific — a minimal request is cheaper to debug and less likely to trip a provider's
validator.

When no schema is published, the challenge still names the upstream in `resource.url`; consult
*that* provider's own API docs (web search, or its docs site) for the payload shape. The service's
ENS `url` record is the same endpoint if the challenge omits it.

### Choosing the input values

The schema tells you the shape; you still have to choose values, and they should be derived at run
time rather than remembered:

- Prefer inputs you already have — the agent wallet's own address, a domain or handle already in
  play, a well-known public entity. They make the response easy to sanity-check because you know
  what it should say.
- Prefer whatever the provider treats as its cheapest, smallest query: one address rather than ten,
  a small page size, the narrowest field list the schema allows.
- **Only ever call a read or search route.** Some of these providers expose write routes on the
  same host — booking, purchasing, sending. A sweep exists to exercise the payment and
  verification path, and a real booking is not something a smoke test gets to do. If the paid
  resource itself performs an action rather than returning data, skip it and say why.

A published schema can also be subtly wrong — an object documented where the endpoint wants a bare
array, say. If a payload that satisfies the schema is still rejected, try the obvious alternative
wrapping once before treating it as a provider fault.

## Step 3 — Pay

Confirm the route, then spend:

```bash
circle services inspect "https://<slug>.verdikt.bond/" -X POST --output json
circle services pay     "https://<slug>.verdikt.bond/" \
  -X POST \
  --address <wallet> \
  --chain <CHAIN from the challenge> \
  --data '<payload built in step 2>' \
  --timeout 60 \
  --output json
```

`--estimate` in place of `--data` previews price and route without signing; `--max-amount` caps a
call when the user has named a ceiling.

Work one service at a time and read each result before the next. These are independent paid calls
to independent third parties, so a failure on one says nothing about the next — but batching them
makes it much harder to attribute a charge to a call.

## Step 4 — Read the verdicts back

```bash
node .claude/skills/verdikt-paid-call-sweep/scripts/verdicts.mjs --blocks 40000
```

This is what makes a sweep meaningful rather than just a pile of API calls. Payloads coming back
proves the *provider* worked; only a verdict on Arc proves *Verdikt* worked. A sweep that returned
good data and wrote zero verdicts means the verification path is broken, and nothing in the
payloads would have told you.

How to read it:

- One verdict per paid call. A service you could not pay writes nothing, correctly — a 402 on the
  replay means the provider says it was not paid, so there is no delivered call to judge.
- `PASS` / `FAIL` / `DOWN`, where `FAIL` and `DOWN` each draw a refund from the provider's bond.
- Cross-check the refunds against step 1: the provider's bond drops by exactly the refunded total.
  That is a second, independent confirmation that the accounting ran, derived from a different
  event than the refund log itself.
- A refund is *credited*, never pushed — `setVerdict` books `owed[payer]` and sends nothing.

## The traps

Ordered by what they cost you. All of these are properties of the protocol and the tooling, not of
any particular service, so expect them against a roster you have never seen.

**A failure after authorization still charges.** `PAYMENT WAS SUBMITTED — funds may have moved`,
or an upstream 400/502/timeout once the payment has gone through, means the money is gone and you
got nothing. Never blind-retry the same payload. Read `~/.circle-cli/payments/` for the saved log
and compare the relevant ledger against its pre-call value: a timeout that did not move the
balance is safe to retry, a 400 that did is a real loss. Retry at most once, changing something
real — a different input, a longer timeout. Paying repeatedly for the same broken call just buys
the same failure again.

**`inspect` and `pay` default to GET, and many of these providers are POST-only.** A GET reaches
the upstream and returns *its* 404/405 routing error, so `inspect` reports `status: unavailable`
and a perfectly payable service looks dead. Pass `-X POST` before concluding anything is down.
This single default accounts for most apparent breakage.

**Non-EVM options are unreachable.** The Circle agent wallet is EVM-only (`circle blockchain list`
has no Solana entry), so a Solana-only challenge cannot be paid from it. Report it and move on
rather than hunting for a route that does not exist.

**`--chain` must come from the challenge, not from habit.** Providers accept different sets, and
some do not accept Base at all. If the CLI refuses a chain it names the accepted ones in the hint —
that hint is authoritative.

**Gateway-paid refunds strand.** Under `GatewayWalletBatched` the deposit is held by the agent
wallet's *backing EOA*, so `authorization.from` — and therefore the `payer` a verdict books
`owed[]` to — is that EOA, not the smart account. `withdraw()` is `msg.sender`-gated, and that EOA
has never transacted on Arc and holds no gas there. So a refund earned on a Gateway-paid call is
real, visible in `getOwed`, and currently unclaimable; the verdicts script shows it as a different
payer from vanilla calls. Do not "fix" the payer derivation — it names the account actually
debited. See the `gateway-payer-is-backing-eoa` note.

**The default 30s timeout is too short for fan-out queries.** Anything doing a batch lookup or a
multi-network scan can exceed it. Pass `--timeout 60`.

**A challenge is not always in the response body.** Some providers answer `content-length: 0` and
put the document in a base64 `payment-required` header, so a plain `curl | jq` sees nothing.
`challenge.mjs` reads both; the Circle CLI handles it too.

**An async job envelope is a success.** Some paid responses are a job handle (`jobId`, `pollUrl`,
a token) rather than results, and such a provider's SLA typically asserts only that envelope's
shape. Poll the URL separately if the user wants the results — do not re-pay.

## Reporting back

Give a per-service line: outcome, the price actually paid, and one clause on what came back or why
it failed. Then the totals — spend per ledger, and the verdict tally from step 4. Keep the three
endings distinct, because they need different follow-ups: paid and delivered; paid and *not*
delivered, which is a real loss worth flagging; and never paid, which is blocked but free.

Flag it when a provider returns sensitive personal data — contact-enrichment services answer with
a named individual's email, phone, and employment history. It is the provider's data product and
the user paid for it, so return it; just do not bury the fact.
