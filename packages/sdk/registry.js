// @verdikt/sdk/registry — the JS side of the Arc registry ABI.
//
// The enum mappings below are implemented rather than stubbed: they ARE the
// seam. Getting an ordinal wrong would silently reclassify a FAIL as a PASS.

/**
 * Mirrors `IVerdiktRegistry.Outcome`. Changing either side without the other
 * is a correctness bug, not a refactor.
 * @type {Readonly<Record<SlaOutcome, number>>}
 */
export const OUTCOME_ORDINAL = Object.freeze({
  PASS: 0,
  FAIL_CONFORMANCE: 1,
  FAIL_UNREACHABLE: 2
});

/**
 * Mirrors `IVerdiktRegistry.Status`.
 * @type {Readonly<Record<ServiceStatus, number>>}
 */
export const STATUS_ORDINAL = Object.freeze({
  NONE: 0,
  ACTIVE: 1,
  SUSPENDED: 2,
  DEREGISTERED: 3
});

/** @type {SlaOutcome[]} */
const OUTCOME_BY_ORDINAL = ['PASS', 'FAIL_CONFORMANCE', 'FAIL_UNREACHABLE'];

/** @type {ServiceStatus[]} */
const STATUS_BY_ORDINAL = ['NONE', 'ACTIVE', 'SUSPENDED', 'DEREGISTERED'];

/**
 * @param {SlaOutcome} outcome
 * @returns {number}
 */
export function outcomeToOrdinal(outcome) {
  if (!Object.hasOwn(OUTCOME_ORDINAL, outcome)) throw new Error(`unknown outcome: ${outcome}`);
  return OUTCOME_ORDINAL[outcome];
}

/**
 * @param {number} ordinal
 * @returns {SlaOutcome}
 */
export function outcomeFromOrdinal(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= OUTCOME_BY_ORDINAL.length) {
    throw new Error(`unknown outcome ordinal: ${ordinal}`);
  }
  return OUTCOME_BY_ORDINAL[ordinal];
}

/**
 * @param {number} ordinal
 * @returns {ServiceStatus}
 */
export function statusFromOrdinal(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= STATUS_BY_ORDINAL.length) {
    throw new Error(`unknown status ordinal: ${ordinal}`);
  }
  return STATUS_BY_ORDINAL[ordinal];
}

/**
 * Derive a serviceId from a slug: `keccak256(utf8Bytes(slug))`.
 *
 * The slug is one identifier reused across three surfaces — the Arc
 * serviceId, the `<slug>.verdikt.bond` route and the `<slug>.verdikt.eth`
 * subname (Specification.md §3) — so this derivation must agree exactly with
 * `IVerdiktRegistry.serviceIdOf`. Phase 2 should assert that against the
 * deployed contract rather than trusting both to be right.
 *
 * @param {string} slug
 * @returns {string} 0x-prefixed 32-byte hex
 */
export function serviceIdOf(slug) {
  throw new Error('NOT_IMPLEMENTED: serviceIdOf() — Tasks.md Phase 2');
}
