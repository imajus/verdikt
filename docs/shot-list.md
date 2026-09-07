# Verdikt — 3-minute recording script

[`walkthrough.md`](./walkthrough.md) is the full tour and runs long for a
submission. This is the cut: seven shots, ~3:00, ordered so the strongest claim
lands first and every number on screen is one you can re-read off a public
chain afterwards.

**Before you start**

```bash
cd cre/workflows && cre workflow simulate verify --broadcast --listen   # terminal 2
cd web && VITE_ARC_RPC_URL=$ARC_RPC_URL pnpm dev                        # terminal 3
```

Have the dashboard already loaded on `weather-lite`'s detail view. Export
`REGISTRY=0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af` and
`RESOLVER=0x3d411f1bA3B11B630a2405F1Fb51f088Cc2E23C9`.

---

### 1 · The claim — 0:00–0:20 · dashboard, service list

> "Two API services. Same provider, same upstream. One publishes an SLA it can
> meet; the other promises a field it doesn't return. Both took real money.
> The marketplace already knows which is which — and nobody filed a complaint."

Point at the two conformance numbers: **500** and **0**.

### 2 · What it promised — 0:20–0:45 · dashboard, `weather-lite` detail

> "This is the provider's own SLA, read from `weather-lite.verdikt.eth` on ENS.
> It's not our description of the service — it's theirs. Verdikt never writes
> this record; the resolver only lets the provider write it."

Scroll the clause table. Rest on `current-weather-shape`.

### 3 · What it delivered — 0:45–1:10 · same view, verdict table

> "And here's every paid call. Not just that it failed — *which promise broke*.
> The chain stores a hash of the clause id; the page resolves it against the SLA
> it just read."

Point at the **Broke** column: `current-weather-shape`.

> "The `weather` one broke a different clause — `price-band`. It was charged
> outside the range it advertised."

### 4 · The refund, from the chain — 1:10–1:45 · terminal

```bash
cast call $REGISTRY 'getVerdict(bytes32)(...)' 0x0606…  --rpc-url $ARC_RPC_URL
cast call $REGISTRY 'getOwed(address)(uint256)' 0x1111…1111 --rpc-url $ARC_RPC_URL
```

> "Paid 2500 units, credited 2500 — capped at what was actually paid. The other
> one paid 2.5 USDC and got the 1 USDC fixed refund. The cap binds from both
> directions, which is what stops a refund ever being worth inducing."

> "And it's *credited*, not sent. If we pushed the money, a payer that rejects
> transfers could revert the call and erase its own FAIL."

### 5 · Who decided — 1:45–2:20 · terminal 2

Fire a trigger; let the Nitro banner show.

> "The judgement happens in a Chainlink confidential workflow. It makes the paid
> call from inside the enclave, evaluates the response against the SLA, and
> hands the DON a report to sign. Verdikt has no key on this path — the
> forwarder writes the verdict, and the registry only accepts reports from it."

Point at the clause output: two clauses broke, the first is what's recorded.

### 6 · The loop closes — 2:20–2:40 · terminal

```bash
cast call $RESOLVER 'text(bytes32,string)(string)' \
  $(cast namehash weather.verdikt.eth) conformance --rpc-url $SEPOLIA_RPC_URL
```

> "The hourly run recomputes the trailing ratios from those events and writes
> them back to ENS. **500** — one pass, one fail. That's the number the
> marketplace ranks on, and it came from the verdicts, not from us."

### 7 · The line — 2:40–3:00

> "Pay through Verdikt and the SLA is enforced per call, from the provider's own
> bond, with no dispute step — because there's nothing to dispute. The provider
> wrote the promise, the enclave checked it, and the chain has both."

---

**Say what isn't real.** One line, and it buys more credit than it costs:

> "The enclave is simulated — CRE deploy access is still early access — and
> these verdicts carry a fixture payer, because the demo paywall advertises the
> open payment scheme and then refuses it. Everything else is on a public
> testnet."

**If a judge asks about the payment leg** — this is a strong answer, so have it
ready rather than in the cut:

> "We sign a real x402 header, and Base Sepolia USDC accepted the authorization
> inside it — that transaction is in the repo. The payer is *recovered* from
> that signature, not read out of JSON, which matters because it decides who a
> refund goes to. Our provider just doesn't honour the scheme it advertises."

**Avoid on camera:** `.env`, any private key, the `cre` login. Verdict request
ids are fine — they're public.
