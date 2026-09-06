// @verdikt/sdk/payment — X-PAYMENT decoding (Tasks.md 0.4, Spike C).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ STUB. Returns fixture data for ANY input. Every refund in the system     │
// │ targets the address this function returns, so shipping the stub past     │
// │ Spike C would send every refund to the fixture payer.                    │
// └──────────────────────────────────────────────────────────────────────────┘

import { DECODED_PAYMENT } from '@verdikt/fixtures';

/**
 * Recover the paying agent and the amount it paid from an x402 `X-PAYMENT`
 * header.
 *
 * Async even though header decoding is synchronous. Spike C has to establish
 * whether payer and amount are cryptographically bound to the header — signed
 * by the payer — or merely asserted in a JSON blob; if the binding turns out
 * to be weak, the documented fallback is to read both from the settlement
 * receipt instead, which is a network call. Committing to a sync signature now
 * would mean every call site changes when that fallback is taken. This is the
 * same containment argument as `resolveServiceRecord`.
 *
 * `amount` is normalised to an integer in the asset's minor units so that
 * @verdikt/sla never depends on how the header encodes it.
 *
 * @param {string} header raw `X-PAYMENT` header value
 * @returns {Promise<DecodedPayment>}
 */
export async function decodePayment(header) {
  if (typeof header !== 'string' || header.length === 0) {
    throw new Error('decodePayment: header must be a non-empty string');
  }
  return { payer: DECODED_PAYMENT.payer, amount: DECODED_PAYMENT.amount };
}
