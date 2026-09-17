// Clause evaluators. Private to @verdikt/sla — the stable seam is `evaluate`
// plus `SlaObservation` and `SlaEvaluation`, and nothing outside this package
// reaches into a clause.

import { validate } from './jsonschema.js';

/** Result-only clause id, always first. Providers may not declare it. */
export const DELIVERY_CLAUSE_ID = 'delivery';

// A semantic clause's `criteria` can run up to 2048 characters, and several
// can appear on one SLA — enough, with the relayed response body, to push the
// per-call CRE result past the workflow's 100kb `ExecutionResponseLimit`
// (cre/workflows/limits.json). The full text is already readable on the SLA
// itself (the ENS `sla` record); the result only needs enough of it to show a
// reader what was promised, so it is truncated here rather than carried whole.
const MAX_CRITERIA_IN_RESULT = 200;

/** @param {string} criteria */
const truncateCriteria = (criteria) =>
  criteria.length > MAX_CRITERIA_IN_RESULT ? `${criteria.slice(0, MAX_CRITERIA_IN_RESULT)}…` : criteria;

/** @param {string} pointer */
const display = (pointer) => (pointer === '' ? '(root)' : pointer);

/**
 * The one predicate no provider declares and none can waive.
 *
 * A 5xx is the provider reporting its own failure; no reading of an SLA makes
 * that a delivered response, and the status-only fallback already scores it
 * FAIL (Specification.md §1). Without this, an SLA declaring only a latency
 * bound would collect a PASS for a 500 returned in 5ms — leaving the full path
 * more lenient than the fallback, which is backwards.
 *
 * A 4xx deliberately passes. With a readable SLA the provider holds the pen and
 * can declare what its rejections look like, and the refund cap
 * (Specification.md §3) is what keeps garbage-request farming break-even.
 *
 * @param {SlaObservation} observation
 * @returns {SlaClauseResult}
 */
export function evaluateDelivery(observation) {
  if (observation.status === null) {
    return {
      id: DELIVERY_CLAUSE_ID,
      type: 'delivery',
      pass: false,
      expected: 'a response',
      actual: `no response (${observation.transportError ?? 'unknown transport error'})`
    };
  }
  return {
    id: DELIVERY_CLAUSE_ID,
    type: 'delivery',
    pass: observation.status < 500,
    expected: 'HTTP status < 500',
    actual: String(observation.status)
  };
}

/**
 * @param {SlaClause} clause
 * @param {SlaObservation} observation
 * @returns {SlaClauseResult}
 */
export function evaluateClause(clause, observation) {
  switch (clause.type) {
    case 'schema': {
      const failure = validate(clause.schema, observation.body);
      return {
        id: clause.id,
        type: 'schema',
        pass: failure === null,
        expected: failure ? `${display(failure.pointer)}: ${failure.expected}` : 'body matches schema',
        actual: failure ? `${display(failure.pointer)}: ${failure.actual}` : 'body matches schema'
      };
    }
    case 'latency':
      return {
        id: clause.id,
        type: 'latency',
        pass: observation.latencyMs <= clause.maxMs,
        expected: `<= ${clause.maxMs}ms`,
        actual: `${observation.latencyMs}ms`
      };
    case 'priceRange': {
      // Integer comparison only: a float here could make the same call PASS on
      // one run and FAIL on the next at the boundary (Tasks.md 1.3).
      const min = BigInt(clause.minMinorUnits);
      const max = BigInt(clause.maxMinorUnits);
      return {
        id: clause.id,
        type: 'priceRange',
        pass: observation.paidAmount >= min && observation.paidAmount <= max,
        expected: `${clause.minMinorUnits}..${clause.maxMinorUnits} ${clause.asset} minor units`,
        actual: `${observation.paidAmount} ${clause.asset} minor units`
      };
    }
    case 'semantic':
      // Recognised, never enforced. `evaluate` is pure by invariant — no I/O,
      // no clock, no network — so it cannot judge whether a response *meant*
      // what was promised; that is what the GenLayer leg is for
      // (docs/GenLayer.md).
      //
      // Passing is the only safe answer. Failing would let any provider who
      // adds a semantic clause be refunded against on every call by a judge
      // that never read the criteria, and throwing would drop the whole
      // document to the status-only fallback, silently disabling every
      // deterministic clause declared alongside it.
      //
      // It still appears in the result list, because a reader needs to see
      // that the provider promised this and that CRE did not decide it.
      return {
        id: clause.id,
        type: 'semantic',
        pass: true,
        expected: truncateCriteria(clause.criteria),
        actual: 'not judged here — semantic clauses are decided on dispute'
      };
    default:
      // Unreachable: the SLA is validated against schema.json first. Kept so a
      // new clause type cannot be added without failing loudly here.
      throw new Error(`sla: unknown clause type "${/** @type {SlaClauseBase} */ (clause).type}"`);
  }
}
