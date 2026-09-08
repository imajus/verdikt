// The payTo check — the unpaid leg's whole job (Specification.md §2, §4).
//
// This runs in ordinary proxy code, outside the enclave, because a 402
// challenge is public: there is nothing here a provider needs attestation for.
//
// It is also the one check in the system that has to happen *before* the fact.
// Every other Verdikt check is post-hoc and backed by the bond; a payment sent
// to a spoofed `payTo` never touches the bonded service at all, so there is
// nothing to reclaim it from. On any doubt this blocks.

/** @type {Readonly<Record<string, ChallengeBlockReason>>} */
export const BLOCK_REASON = Object.freeze({
  NO_ADDRESS_RECORD: 'no_address_record',
  UNPARSEABLE_CHALLENGE: 'unparseable_challenge',
  NO_PAY_TO: 'challenge_has_no_pay_to',
  PAY_TO_MISMATCH: 'pay_to_mismatch',
  OWNER_MISMATCH: 'owner_mismatch'
});

/**
 * @param {string} body raw 402 response body
 * @param {string|null} expectedPayTo the service's ENS address record
 * @returns {{ ok: true } | { ok: false, reason: ChallengeBlockReason, detail: string }}
 */
export function checkChallenge(body, expectedPayTo) {
  if (!expectedPayTo) {
    // Nothing to compare against. Relaying anyway would mean the agent signs a
    // payment to an address Verdikt never vouched for, which is exactly the
    // case this check exists for.
    return {
      ok: false,
      reason: BLOCK_REASON.NO_ADDRESS_RECORD,
      detail: 'the service has published no address record, so its payTo cannot be verified'
    };
  }

  let challenge;
  try {
    challenge = JSON.parse(body);
  } catch {
    return {
      ok: false,
      reason: BLOCK_REASON.UNPARSEABLE_CHALLENGE,
      detail: 'the 402 body is not JSON, so its payTo cannot be read'
    };
  }

  const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  /** @type {unknown[]} */
  const payTos = accepts
    .map((/** @type {{ payTo?: unknown }} */ entry) => entry?.payTo)
    .filter((/** @type {unknown} */ value) => value !== undefined);
  if (payTos.length === 0 || payTos.length !== accepts.length) {
    return {
      ok: false,
      reason: BLOCK_REASON.NO_PAY_TO,
      detail: 'the 402 challenge offers no payment option carrying a payTo'
    };
  }

  const expected = expectedPayTo.toLowerCase();
  // Every option, not just the first: the agent may pick any of them, so one
  // spoofed entry among honest ones is still a spoofed payment.
  const wrong = payTos.filter((value) => typeof value !== 'string' || value.toLowerCase() !== expected);
  if (wrong.length > 0) {
    return {
      ok: false,
      reason: BLOCK_REASON.PAY_TO_MISMATCH,
      detail: `challenge pays to ${wrong.map((p) => String(p)).join(', ')}, but the service published ${expectedPayTo}`
    };
  }
  return { ok: true };
}

/**
 * Refuses to relay when the ENS subname's owner and the Arc service's
 * registered provider disagree.
 *
 * A permissionless registrar (`VerdiktSubnameRegistrar`) means the ENS side
 * of a slug and the Arc side are two independent first-come claims with
 * nothing binding them once anyone but the operator can claim either. Without
 * this, a slug claimed on Arc by Alice but on ENS by Mallory would relay
 * through Mallory's `url` record and pay Mallory's `address` record —
 * silently, since both records individually look well-formed.
 *
 * `recordOwner === null` (nobody has claimed the subname through the
 * registrar yet) is not a mismatch: it falls through to the existing
 * `NO_ADDRESS_RECORD`/`NO_PAY_TO` checks, which already refuse an unclaimed
 * listing for a reason that stands on its own.
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
