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
