// @verdikt/sla — SLA evaluation engine (Specification.md §1, Tasks.md Phase 1).
//
// Seam only. Phase 1 supplies the bodies.
//
// Two hard rules the implementation inherits from the spec:
//   1. Pure. No I/O, no clock, no network, no floating point, no key-order or
//      locale dependence. A verdict is final with no dispute layer, so
//      non-determinism here burns a real bond.
//   2. Dependency-free. This bundles into the CRE workflow.

/** @type {Readonly<Record<SlaOutcome, SlaOutcome>>} */
export const OUTCOME = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  DOWN: 'DOWN'
});

/**
 * Evaluate an observed call against the provider's declared SLA.
 *
 * Returns one of the three outcomes — never `null`. `observation.status ===
 * null` yields `DOWN`; a response that arrived and broke a clause
 * yields `FAIL`.
 *
 * Throws on a malformed SLA, a missing field or an unknown clause type, so the
 * caller falls back to `evaluateStatusOnly` rather than silently manufacturing
 * a refund out of a provider's bond (Specification.md §1).
 *
 * @param {SlaDocument} sla
 * @param {SlaObservation} observation
 * @returns {SlaEvaluation}
 */
export function evaluate(sla, observation) {
  throw new Error('NOT_IMPLEMENTED: @verdikt/sla evaluate() — Tasks.md Phase 1.2');
}

/**
 * Fallback for when the `sla` ENS record is unreachable or will not parse.
 *
 * 2xx -> PASS, 5xx -> FAIL, 4xx -> `outcome: null`, meaning write
 * no verdict at all. Kept a separate function rather than a branch inside
 * `evaluate` because its contract genuinely differs: this one can decline to
 * produce a verdict, and every caller has to handle that.
 *
 * @param {SlaObservation} observation
 * @returns {SlaStatusOnlyEvaluation}
 */
export function evaluateStatusOnly(observation) {
  throw new Error('NOT_IMPLEMENTED: @verdikt/sla evaluateStatusOnly() — Tasks.md Phase 1.4');
}
