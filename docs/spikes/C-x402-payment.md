# Spike C — recovering the payer and amount from an x402 payment

Answers [Tasks.md §0.4](../Tasks.md); resolves the payment-recovery entry under
[Requirements.md §9](../Requirements.md) and settles the payer/amount mechanics
assumed by [Specification.md §2](../Specification.md).

**Verdict: the payer and the amount are bound to the payer's signature. The
settlement-receipt fallback is not taken for identity — but a separate half of
it is now required, see §4.**

Reproduce with `pnpm spike:payment` (7 checks; `--live` adds 3 more that read
Arc Testnet over RPC) and `pnpm vitest run packages/sdk/payment.test.js`
(37 tests).

## 1. Verdict

**The payer and the amount are cryptographically bound to the payer's
signature.** They are not merely asserted in a JSON blob, and the documented
fallback — reading them from the settlement receipt instead — is not needed.

`decodePayment` in `packages/sdk/payment.js` is implemented against that
finding: it recovers the signer and returns nothing unless the recovered
address equals the payer named in the payload.

The fallback is not needed for *identity*. It is still needed for
*settlement*, which turns out to be a separate question the task did not
distinguish — see §4. That is the finding with consequences.

## 2. What the header actually is

`X-PAYMENT` is `base64(JSON.stringify(paymentPayload))` — the standard base64
alphabet, no base64url — where the payload for x402 v2 is:

```json
{
  "x402Version": 2,
  "resource": { "url": "…", "description": "…", "mimeType": "application/json" },
  "accepted": { "scheme": "exact", "network": "eip155:5042002", "amount": "2500",
                "asset": "0x3600…0000", "payTo": "0x7099…79C8", "maxTimeoutSeconds": 300,
                "extra": { "name": "GatewayWalletBatched", "version": "1",
                           "verifyingContract": "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" } },
  "payload": {
    "authorization": { "from": "0xf39F…2266", "to": "0x7099…79C8", "value": "2500",
                       "validAfter": "1788699400", "validBefore": "1789304900",
                       "nonce": "0x804d…5791" },
    "signature": "0xd69a…1b"
  }
}
```

The payer is `payload.authorization.from`; the amount is
`payload.authorization.value`, a decimal integer string in the asset's minor
units.

Two corrections to how the docs described this:

- **`GatewayWalletBatched` is not a scheme.** It is the EIP-712 *domain name*
  Circle's batching SDK signs under, carried in `accepts[].extra.name`. The
  scheme string is `exact` — the same one vanilla x402 uses. Requirements §9
  and Specification §6 have been reworded.
- **`accepted` is part of the header.** x402 v2 echoes the selected
  `accepts[]` entry back inside the payload, which is what makes the header
  self-contained enough to verify without a side channel. x402 v1 did not, and
  a v1 header therefore cannot be verified from itself at all — `decodePayment`
  rejects v1 unless the caller supplies the provider's requirements.

## 3. Why the binding holds

Both schemes sign an EIP-3009 `TransferWithAuthorization` struct — `from`,
`to`, `value`, `validAfter`, `validBefore`, `nonce` — under an EIP-712 domain.
`from` and `value` are *fields of the signed struct*, so recovering the
signature yields an address that changes if either is touched. Naming someone
else as payer means producing their signature over that exact message.

The two schemes differ only in the domain:

| | vanilla `exact` | Circle batched |
|---|---|---|
| `extra.name` / `.version` | the token's, e.g. `USD Coin` / `2` | `GatewayWalletBatched` / `1` |
| `verifyingContract` | the USDC token address | the GatewayWallet, `extra.verifyingContract` |

One recovery routine covers both, which is what lets the proxy relay whatever
a provider's challenge advertises (Specification §2) rather than hard-coding
Circle's rails.

The domain itself is *not* signed, so it arrives attacker-controlled like the
rest of the envelope. That does not weaken the binding — no choice of domain
makes a signature recover to an address whose key you do not hold — but it
does mean the domain proves nothing on its own. `decodePayment` accepts an
optional `requirements` argument so a caller holding the provider's live 402
can pin it, and the enclave should pass it.

`packages/sdk/payment.test.js` is where the claim is actually tested: a
tampered payer, an inflated amount, a redirected `payTo`, a shifted validity
window, a replaced nonce and a swapped domain each fail to recover.

## 4. What the header does not prove

**A signed authorization is an intent to pay, not a payment.** This is the
part that changes what the verification workflow must confirm.

Nothing in a well-formed header says Gateway ever moved the money. An
authorization can be signed and then fail to settle — insufficient Gateway
balance, a reused nonce, an expired window. A payer who wants a free refund
does not need to forge anything: it signs a real authorization with its own
key, ensures settlement fails, and collects against the bond on a
`DOWN` verdict. Every signature check above passes.

Two details make this worse than it first looks:

- **The authorization is valid for seven days.** Circle clamps `validBefore`
  to `now + 7d + 100s`, so `validBefore` is not a freshness signal and a
  header stays presentable for a week.
- **Replay protection lives at the facilitator, not in the header.** The only
  thing that makes an authorization single-use is Gateway rejecting a repeated
  `nonce` at settlement.

So: **the per-request workflow must confirm settlement before writing a
verdict.** `decodeSettlement` reads the provider's `X-PAYMENT-RESPONSE`
receipt for exactly that, and the workflow should require `success: true` and
that the receipt's `payer` agrees with the recovered one. The receipt is
unsigned — the facilitator's word — so it is evidence of settlement, never the
source of the refund target; that stays the recovered signer.

Two follow-ons for Phase 2 and Phase 3:

- **Use `authorization.nonce` as the registry's `requestId`.** It is inside
  the signed struct, unique per authorization, and already enforced as
  single-use by Gateway. The existing "a second refund on the same request
  reverts" rule then lines up exactly with the settlement layer's own replay
  guard instead of approximating it.
- **A verdict must not be written on an unsettled payment at all** — not
  a `DOWN`, not anything. No settlement, no verdict.

## 5. Units: the paid amount is not in the bond's units

`decimals()` on Arc Testnet USDC (`0x3600…0000`) returns **6**. Arc's *native*
USDC — the `msg.value` the bond, refunds and `owed` balances are counted in —
has **18**.

So `paidAmount` as it comes off the header is 10^12 times smaller than the
same sum expressed as a deposit. Passing it straight into
`min(FIXED_REFUND, paidAmount, remaining deposit)` would make `paidAmount` win
every comparison and pay out a trillionth of what was paid, on a verdict with
no dispute layer to catch it.

`toArcNativeUnits` in `packages/sdk/registry.js` does the conversion and
refuses to scale down rather than truncating. Phase 2 should decide whether
the scaling happens before `setVerdict` (as now) or inside the contract, and
assert it either way.

## 6. Smart-account payers — open

The x402 facilitator validates signatures with a routine that also accepts
ERC-1271 (deployed smart account) and ERC-6492 (counterfactual, not yet
deployed) signatures. Plain ECDSA recovery cannot check either, and an
ERC-1271 check needs an on-chain call.

`decodePayment` detects the ERC-6492 wrapper and rejects it with a distinct
`smart-account-signature` code rather than recovering an address that means
nothing. Left open deliberately: the demo payer is an EOA, and pull payments
(Specification §3) already make a contract payer safe on the refund side. If
smart-account payers matter later, the enclave gains an `eth_call` to
`isValidSignature`.

## 7. What is still not captured

No payment has settled on Arc from this repository. `fixtures/x402.js` is
generated by `scripts/spike-payment.mjs` and its provenance note says which
parts are real:

- **Real**: the Arc chain id, USDC address and its 6 decimals, and the
  deployed GatewayWallet, all read over RPC; the payload and challenge shapes,
  taken from `@x402/core@2.25.0` and `@circle-fin/x402-batching@3.4.0` and
  cross-checked against a 402 recorded from a live production x402 seller
  (`PRODUCTION_402_CHALLENGE`); the EIP-712 signature, which genuinely
  recovers.
- **Synthetic**: the payer and provider identities (Anvil test accounts), the
  amount, the resource URL, the frozen validity window, and
  `SETTLEMENT_RECEIPT`.

That is enough to develop and test decoding, binding and every failure mode
without spending money. It is not evidence that a payment settled. When the
demo provider stands up (Tasks.md §0.6), capture a real paid call and replace
`SETTLEMENT_RECEIPT` and `X_PAYMENT_RESPONSE_HEADER` with the recorded pair —
the shapes above are what to expect, and the tests should keep passing.

## 8. Where this meets Spike B

Spike B ([spikes/cre.md](./cre.md)) landed while this one was open, and its
workflow deliberately leaves the header alone — it "passes an opaque
`paymentHeader` string through unexamined, because what is inside it is Spike
C's question, not this one." That question now has an answer, so three things
change for `cre/spike/verify/workflow.ts` when it stops being a spike:

- **`payer` and `paidAmountMinorUnits` should not be trigger inputs.** The
  spike takes both from the proxy's `VerifyRequest`, which means the refund
  target is asserted by code running *outside* the enclave. Both are
  recoverable inside it, bound to the agent's signature — call `decodePayment`
  on the header the workflow is already carrying, and cross-check the result
  against what the request claims rather than trusting it.
- **Scale `paidAmount` before it goes into the report.** The report ABI
  (`uint256 paidAmount`) feeds `setVerdict`, whose refund cap compares it with
  the deposit — and the deposit is native USDC at 18 decimals while the
  authorization is the ERC-20's 6. `toArcNativeUnits` belongs on that value,
  not on the trigger input.
- **`requestId` can stop being a trigger input too.** The authorization's
  nonce is inside the signed struct and already enforced single-use by the
  facilitator, so it is a stronger key for the registry's replay guard than
  anything the proxy can mint.

The settlement check from §4 lands in the same place, before
`donRuntime.report(...)`. Spike B's finding that verdicts arrive as
`onReport(metadata, report)` rather than a direct `setVerdict` call does not
disturb any of this: the payload is the same five fields, only the transport
differs.
