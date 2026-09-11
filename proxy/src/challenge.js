// The ownership check — ENS subname owner vs. Arc registered provider
// (Specification.md §2, §4).
//
// This runs in ordinary proxy code, outside the enclave, because the values
// compared (an ENS owner, an Arc provider address) are both public.

/** @type {Readonly<Record<string, ChallengeBlockReason>>} */
export const BLOCK_REASON = Object.freeze({
  OWNER_MISMATCH: 'owner_mismatch'
});

/**
 * Decode a 402 challenge, preferring x402 v2's `payment-required` response
 * header over the body.
 *
 * v1 has no such header: `accepts` lives only in the JSON body. v2 moves the
 * challenge into the header and does not obligate a provider to repeat it in
 * the body — Alchemy happens to (a convenience, not a guarantee), so reading
 * the header first is what makes this work against a provider that doesn't.
 *
 * Used by `verified()`'s accepts-probe (router.js) to find the `accepts`
 * array `decodePayment` needs. No payTo check reads this any more — that
 * check was removed as security theater (issue #37): the proxy's only trust
 * anchor is the service's registered `url`, not anything the challenge itself
 * names.
 *
 * @param {string|null|undefined} paymentRequiredHeader the `payment-required` response header, if any
 * @param {string} body raw 402 response body, used when the header is absent or itself unparseable
 * @returns {Record<string, any> | null}
 */
export function decodeChallenge(paymentRequiredHeader, body) {
  if (paymentRequiredHeader) {
    try {
      return JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString('utf8'));
    } catch {
      // Fall through to the body.
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Refuses to relay when the ENS subname's owner and the Arc service's
 * registered provider disagree.
 *
 * A permissionless registrar (`VerdiktSubnameRegistrar`) means the ENS side
 * of a slug and the Arc side are two independent first-come claims with
 * nothing binding them once anyone but the operator can claim either. Without
 * this, a slug claimed on Arc by Alice but on ENS by Mallory would relay
 * through Mallory's `url` record — silently, since both records individually
 * look well-formed.
 *
 * `recordOwner === null` (nobody has claimed the subname through the
 * registrar yet) is not a mismatch — there is no owner to disagree with.
 *
 * @param {string|null} recordOwner the ENS subname's owner
 * @param {string} arcProvider the Arc-registered provider
 * @returns {{ ok: true } | { ok: false, reason: ChallengeBlockReason, detail: string }}
 */
export function checkOwnership(recordOwner, arcProvider) {
  if (!recordOwner) return { ok: true };
  if (recordOwner.toLowerCase() !== arcProvider.toLowerCase()) {
    return {
      ok: false,
      reason: BLOCK_REASON.OWNER_MISMATCH,
      detail: `the ENS subname is owned by ${recordOwner}, but Arc's registered provider is ${arcProvider} — this slug's two claims disagree and cannot be safely routed`
    };
  }
  return { ok: true };
}
