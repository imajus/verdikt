// What the per-request confidential workflow decides, minus the enclave
// (Specification.md §1, §2; Tasks.md 3.1).
//
// Kept as plain ESM JS in the pnpm workspace, not inside the TypeScript
// workflow, for one reason: `cre workflow simulate` cannot run unattended
// (Spike B, CRE-1), so anything that lives only in the workflow is untested
// code. This is the part that decides whether a provider's bond is touched, so
// it is the part that must not be.
//
// It is pure — the workflow measures latency and hands it in, exactly as
// `evaluate` requires.

import { evaluate, evaluateStatusOnly, parseSla } from '@verdikt/sla';

/** @type {Readonly<Record<string, JudgementMode>>} */
export const JUDGEMENT_MODE = Object.freeze({
  /** The provider's own SLA was read and applied. */
  SLA: 'sla',
  /** The SLA could not be read or would not parse; status-only (spec §1). */
  STATUS_ONLY: 'status-only'
});

/**
 * The provider's own statement that it was not paid.
 *
 * Not a status like any other: every other response is the provider answering a
 * call it was paid for, which is the only thing this system judges. A 402 says
 * the payment leg failed, so there is no delivered call to hold anyone to.
 */
const PAYMENT_REFUSED = 402;

/**
 * Whether an `sla` record is there to be applied at all. Only used to report
 * which mode a declined verdict would have been judged under, so the response
 * header does not claim a fallback that never happened.
 *
 * @param {string|null} slaText
 */
const usableSla = (slaText) => typeof slaText === 'string' && slaText.length > 0;

/**
 * Judge one paid call.
 *
 * The fallback is the conservative half of this function, and it leans that way
 * on purpose: recording a failure when the provider was fine takes money from
 * their bond with no way to appeal, and when the SLA cannot be read that is
 * *Verdikt's* problem, not theirs. So:
 *
 *   - an SLA that will not resolve or will not parse never produces a verdict
 *     out of clause logic — it falls back to status alone;
 *   - the fallback can decline to produce a verdict at all (`outcome: null`),
 *     which is what stops an agent farming refunds with deliberate garbage
 *     during a Verdikt-side outage;
 *   - a `null` outcome means **write nothing to Arc**, not "write a PASS".
 *
 * @param {string|null} slaText the raw `sla` ENS record, or null if unreadable
 * @param {SlaObservation} observation
 * @returns {Judgement}
 */
export function judge(slaText, observation) {
  // Checked ahead of both modes, because it is not a judgement about delivery
  // at all. A refused payment scored as a provider failure is a refund farm:
  // an authorization that cannot settle (correct `payTo`, empty account) costs
  // an attacker nothing, and a FAIL would credit it out of the bond. The
  // status-only fallback already declined this as a 4xx; `evaluate` did not,
  // since a 402 clears the delivery clause and then breaks whatever schema
  // clause the provider declared against the error body.
  //
  // This is also what makes the payer's signed recipient safe to leave
  // unchecked (`decodePayment`): a payment the provider does not accept earns
  // no verdict, so paying the wrong address — or nobody — earns nothing.
  if (observation.status === PAYMENT_REFUSED) {
    return {
      mode: usableSla(slaText) ? JUDGEMENT_MODE.SLA : JUDGEMENT_MODE.STATUS_ONLY,
      outcome: null,
      clauses: [],
      fallbackReason: 'provider refused the payment (402); nothing was delivered to judge'
    };
  }
  if (typeof slaText === 'string' && slaText.length > 0) {
    try {
      const result = evaluate(parseSla(slaText), observation);
      return { mode: JUDGEMENT_MODE.SLA, outcome: result.outcome, clauses: result.clauses, fallbackReason: null };
    } catch (error) {
      // Deliberately swallowed into a mode switch rather than rethrown: the
      // agent has paid, and the response still has to be relayed. What must not
      // happen is a FAIL manufactured out of our own inability to read a
      // document the provider published correctly.
      return {
        ...statusOnly(observation),
        fallbackReason: `sla unusable: ${/** @type {Error} */ (error).message}`
      };
    }
  }
  return {
    ...statusOnly(observation),
    fallbackReason: slaText === null ? 'sla record unreadable' : 'sla record empty'
  };
}

/**
 * @param {SlaObservation} observation
 * @returns {Omit<Judgement, 'fallbackReason'>}
 */
function statusOnly(observation) {
  const result = evaluateStatusOnly(observation);
  return { mode: JUDGEMENT_MODE.STATUS_ONLY, outcome: result.outcome, clauses: result.clauses };
}

/**
 * Whether this judgement should reach Arc at all.
 *
 * Split out from `judge` so the call site cannot forget it. `onReport` has no
 * way to express "no verdict" — every report it accepts writes one — so the
 * skip has to happen before a report is ever built.
 *
 * @param {Judgement} judgement
 * @returns {boolean}
 */
export const shouldWriteVerdict = (judgement) => judgement.outcome !== null;

/**
 * The id of the first clause that failed, or `null` if none did.
 *
 * This is the one piece of the judgement that reaches the chain besides the
 * outcome, which is why it is *the first* rather than all of them: one word
 * per verdict, and the clause order is the SLA's own declared order, so the
 * answer is stable and the provider chose it.
 *
 * `null` is a real answer, not an absence, in two cases that must stay
 * distinguishable from a PASS at the call site:
 *
 *   - a status-only judgement, which evaluates no clauses at all, so a DOWN
 *     from it names nothing.
 *
 * The implicit `delivery` clause CAN be the answer, and is returned by its own
 * id. It is not in any SLA — the validator rejects `id: 'delivery'` — so a
 * reader matches it by name rather than against the declared clauses
 * (`matchFailedClause`). "The provider did not deliver" is a distinct fact from
 * "no clause was named", and flattening the two would lose it.
 *
 * @param {Judgement} judgement
 * @returns {string|null}
 */
export function failedClauseOf(judgement) {
  return judgement.clauses.find((clause) => !clause.pass)?.id ?? null;
}

/**
 * Build the observation the engine judges, from what the enclave saw.
 *
 * Exists so the enclave's one job — measure, don't interpret — stays visible.
 * `latencyMs` is measured by the caller and passed in; the engine never reads a
 * clock, and neither does this.
 *
 * A body that will not parse as JSON is handed over as the raw string rather
 * than discarded: a schema clause of `{"type":"string"}` is legitimate, and
 * throwing here would turn a provider's plain-text response into a DOWN.
 *
 * @param {{ status: number|null, headers?: Record<string,string>, bodyText?: string,
 *           latencyMs: number, paidAmount: bigint, transportError?: string }} seen
 * @returns {SlaObservation}
 */
export function observationFrom(seen) {
  /** @type {unknown} */
  let body = null;
  if (typeof seen.bodyText === 'string') {
    try {
      body = JSON.parse(seen.bodyText);
    } catch {
      body = seen.bodyText;
    }
  }
  return {
    status: seen.status,
    headers: seen.headers ?? {},
    body,
    latencyMs: seen.latencyMs,
    paidAmount: seen.paidAmount,
    ...(seen.transportError ? { transportError: seen.transportError } : {})
  };
}
