// @verdikt/sdk/payment — X-PAYMENT decoding (Tasks.md 0.4, Spike C).
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ STUB. Spike C has not run. This returns fixture data for ANY input, so    │
// │ every refund in the system would go to the fixture payer.                 │
// │                                                                          │
// │ It therefore REFUSES TO RUN unless VERDIKT_ALLOW_STUB_PAYMENT=true is set │
// │ explicitly. That turns "every refund silently misdirected" — which no     │
// │ test would catch, because the tests use the fixture — into a startup      │
// │ failure that names itself.                                                │
// └──────────────────────────────────────────────────────────────────────────┘

import { DECODED_PAYMENT } from '@verdikt/fixtures';

/** Set `VERDIKT_ALLOW_STUB_PAYMENT=true` to develop against the fixture. */
export const STUB_OPT_IN = 'VERDIKT_ALLOW_STUB_PAYMENT';

/** Whether the stub will answer. Exported so a server can refuse to boot rather than fail per request. */
export const isPaymentDecodingImplemented = () => false;

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
 * @verdikt/sla never depends on how the header encodes it. On Arc that is the
 * 6-decimal ERC-20 view, not the 18-decimal native one — `VerdiktRegistry`
 * converts (`NATIVE_PER_MINOR_UNIT`) before capping a refund against the bond.
 *
 * @param {string} header raw `X-PAYMENT` header value
 * @param {{ allowStub?: boolean }} [options]
 * @returns {Promise<DecodedPayment>}
 */
export async function decodePayment(header, options = {}) {
  if (typeof header !== 'string' || header.length === 0) {
    throw new Error('decodePayment: header must be a non-empty string');
  }
  const allowStub = options.allowStub ?? process.env[STUB_OPT_IN] === 'true';
  if (!allowStub) {
    throw new Error(
      `decodePayment: NOT_IMPLEMENTED (Spike C, Tasks.md 0.4). This stub returns the fixture payer for any ` +
        `header, so every refund would be credited to ${DECODED_PAYMENT.payer}. Set ${STUB_OPT_IN}=true to ` +
        'develop against the fixture; never set it anywhere a real bond is at stake.'
    );
  }
  return { payer: DECODED_PAYMENT.payer, amount: DECODED_PAYMENT.amount };
}
