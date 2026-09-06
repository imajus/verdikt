// @verdikt/sla — SLA evaluation engine (Specification.md §1, Tasks.md Phase 1).
//
// Two hard rules the implementation inherits from the spec:
//   1. Pure. No I/O, no clock, no network, no floating point in a price
//      comparison, no key-order or locale dependence. A verdict is final with
//      no dispute layer, so non-determinism here burns a real bond.
//   2. Dependency-free. This bundles into the CRE workflow.

import { DELIVERY_CLAUSE_ID, evaluateClause, evaluateDelivery } from './clauses.js';
import { assertSchema, validate } from './jsonschema.js';
import META_SCHEMA from './schema.json' with { type: 'json' };

// Self-check at load: the meta-schema must itself be inside the subset this
// engine can enforce, so schema.json cannot drift into features the validator
// silently ignores.
assertSchema(META_SCHEMA);

/**
 * The SLA document schema, exported so the dashboard's SLA editor and any
 * provider tooling validate against the same artefact the engine enforces
 * rather than a second copy that can drift.
 */
export const SLA_SCHEMA = META_SCHEMA;

/** @type {Readonly<Record<SlaOutcome, SlaOutcome>>} */
export const OUTCOME = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  DOWN: 'DOWN'
});

/** Decimal integer, no sign, no leading zeros. Linear in the input; bounded to 78 chars by schema.json. */
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

/**
 * @param {unknown} observation
 * @returns {asserts observation is SlaObservation}
 */
function assertObservation(observation) {
  if (observation === null || typeof observation !== 'object') {
    throw new Error('sla: observation must be an object');
  }
  const { status, headers, latencyMs, paidAmount } = /** @type {Record<string, unknown>} */ (observation);
  if (status !== null && (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error(`sla: observation.status must be null or an HTTP status code, got ${String(status)}`);
  }
  if (headers === null || typeof headers !== 'object') {
    throw new Error('sla: observation.headers must be an object');
  }
  if (typeof latencyMs !== 'number' || !Number.isInteger(latencyMs) || latencyMs < 0) {
    throw new Error(`sla: observation.latencyMs must be a non-negative integer, got ${String(latencyMs)}`);
  }
  // The boundary that keeps this engine independent of how X-PAYMENT encodes an
  // amount (Tasks.md 0.4): `decodePayment` normalises to minor units first.
  if (typeof paidAmount !== 'bigint' || paidAmount < 0n) {
    throw new Error(`sla: observation.paidAmount must be a non-negative bigint, got ${typeof paidAmount}`);
  }
}

/**
 * @param {unknown} sla
 * @returns {asserts sla is SlaDocument}
 */
function assertSlaDocument(sla) {
  const failure = validate(META_SCHEMA, sla);
  if (failure) {
    const at = failure.pointer === '' ? 'the SLA root' : failure.pointer;
    throw new Error(`sla: invalid SLA at ${at} — expected ${failure.expected}, got ${failure.actual}`);
  }
  const seen = new Set();
  for (const clause of /** @type {SlaDocument} */ (sla).clauses) {
    if (clause.id === DELIVERY_CLAUSE_ID) {
      throw new Error(`sla: clause id "${DELIVERY_CLAUSE_ID}" is reserved for the implicit delivery predicate`);
    }
    if (seen.has(clause.id)) throw new Error(`sla: duplicate clause id "${clause.id}"`);
    seen.add(clause.id);

    if (clause.type === 'schema') {
      assertSchema(clause.schema, `/clauses/${clause.id}/schema`);
    }
    if (clause.type === 'priceRange') {
      for (const bound of /** @type {const} */ (['minMinorUnits', 'maxMinorUnits'])) {
        if (!DECIMAL_INTEGER.test(clause[bound])) {
          throw new Error(`sla: clause "${clause.id}" ${bound} must be a decimal integer string, got "${clause[bound]}"`);
        }
      }
      if (BigInt(clause.minMinorUnits) > BigInt(clause.maxMinorUnits)) {
        throw new Error(`sla: clause "${clause.id}" has minMinorUnits above maxMinorUnits`);
      }
    }
  }
}

/**
 * Parse and validate the raw `sla` ENS text record.
 *
 * Kept here rather than at the call site so a caller has one thing to wrap in
 * `try`: both a JSON syntax error and a document that is not a valid SLA end up
 * on the same status-only fallback path (Specification.md §1).
 *
 * @param {string} text
 * @returns {SlaDocument}
 */
export function parseSla(text) {
  if (typeof text !== 'string') throw new Error('sla: parseSla() expects the raw text record as a string');
  const parsed = JSON.parse(text);
  assertSlaDocument(parsed);
  return parsed;
}

/**
 * Evaluate an observed call against the provider's declared SLA.
 *
 * Returns one of the three outcomes — never `null`. `observation.status ===
 * null` yields `DOWN`; a response that arrived and broke a clause yields
 * `FAIL`.
 *
 * Every result carries an implicit `delivery` clause ahead of the declared
 * ones; see `evaluateDelivery` for why a 5xx cannot be waived by an SLA and a
 * 4xx is left to the provider's own clauses.
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
  assertObservation(observation);
  assertSlaDocument(sla);

  const delivery = evaluateDelivery(observation);
  if (observation.status === null) {
    // Nothing arrived, so there is no body, no status and no latency worth
    // judging. Reporting fabricated clause results for a call that never
    // happened would put noise in the dashboard's failure detail.
    return { outcome: OUTCOME.DOWN, clauses: [delivery] };
  }

  const clauses = [delivery, ...sla.clauses.map((clause) => evaluateClause(clause, observation))];
  return { outcome: clauses.every((clause) => clause.pass) ? OUTCOME.PASS : OUTCOME.FAIL, clauses };
}

/**
 * Fallback for when the `sla` ENS record is unreachable or will not parse.
 *
 * 2xx -> PASS, 5xx -> FAIL, everything else -> `outcome: null`, meaning write
 * no verdict at all. Kept a separate function rather than a branch inside
 * `evaluate` because its contract genuinely differs: this one can decline to
 * produce a verdict, and every caller has to handle that.
 *
 * The 4xx carve-out stops an agent farming refunds with deliberate garbage: a
 * 4xx is usually the provider correctly rejecting a malformed request, and here
 * — unlike in `evaluate` — there is no SLA to tell the two apart. 1xx and 3xx
 * fall in the same bucket for the same reason: neither is a delivered payload,
 * and guessing at whose fault that is would be manufacturing a verdict.
 *
 * @param {SlaObservation} observation
 * @returns {SlaStatusOnlyEvaluation}
 */
export function evaluateStatusOnly(observation) {
  assertObservation(observation);
  const { status } = observation;
  if (status === null) return { outcome: OUTCOME.DOWN, clauses: [] };
  if (status >= 200 && status < 300) return { outcome: OUTCOME.PASS, clauses: [] };
  if (status >= 500) return { outcome: OUTCOME.FAIL, clauses: [] };
  return { outcome: null, clauses: [] };
}
