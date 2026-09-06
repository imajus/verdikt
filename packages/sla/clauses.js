// Clause evaluators. Private to @verdikt/sla — the stable seam is `evaluate`
// plus `SlaObservation` and `SlaEvaluation`, and nothing outside this package
// reaches into a clause.

import { validate } from './jsonschema.js';

/** Result-only clause id, always first. Providers may not declare it. */
export const DELIVERY_CLAUSE_ID = 'delivery';

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
    default:
      // Unreachable: the SLA is validated against schema.json first. Kept so a
      // new clause type cannot be added without failing loudly here.
      throw new Error(`sla: unknown clause type "${/** @type {SlaClauseBase} */ (clause).type}"`);
  }
}
