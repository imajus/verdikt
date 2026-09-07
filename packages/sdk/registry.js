// @verdikt/sdk/registry — the JS side of the Arc registry ABI.
//
// The enum mappings below are implemented rather than stubbed: they ARE the
// seam. Getting an ordinal wrong would silently reclassify a FAIL as a PASS.

import { keccak256, toBytes } from 'viem';

/**
 * Mirrors `IVerdiktRegistry.Outcome`. Changing either side without the other
 * is a correctness bug, not a refactor.
 * @type {Readonly<Record<SlaOutcome, number>>}
 */
export const OUTCOME_ORDINAL = Object.freeze({
  PASS: 0,
  FAIL: 1,
  DOWN: 2
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
const OUTCOME_BY_ORDINAL = ['PASS', 'FAIL', 'DOWN'];

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
 * A slug valid as both a DNS label and an ENS label. Mirrors
 * `VerdiktRegistry._assertValidSlug`; a slug this rejects would register on Arc
 * and then have no reachable `<slug>.verdikt.bond` route and no
 * `<slug>.verdikt.eth` subname.
 */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Derive a serviceId from a slug: `keccak256(utf8Bytes(slug))`.
 *
 * The slug is one identifier reused across three surfaces — the Arc
 * serviceId, the `<slug>.verdikt.bond` route and the `<slug>.verdikt.eth`
 * subname (Specification.md §3) — so this derivation must agree exactly with
 * `IVerdiktRegistry.serviceIdOf`. Both sides assert the same vectors:
 * `registry.test.js` here and `test_serviceIdOfMatchesTheSharedVector` in
 * `contracts/test/VerdiktRegistry.t.sol`.
 *
 * @param {string} slug
 * @returns {string} 0x-prefixed 32-byte hex
 */
export function serviceIdOf(slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new Error(`serviceIdOf: "${slug}" is not a valid slug (lowercase a-z, 0-9 and -, 1..63 chars)`);
  }
  return keccak256(toBytes(slug));
}

/** The `failedClause` word meaning "no clause was named". */
export const NO_CLAUSE = `0x${'0'.repeat(64)}`;

/**
 * Hash a clause id the way a verdict carries it.
 *
 * @param {string} clauseId
 * @returns {string} 0x-prefixed 32-byte hex
 */
export const clauseHash = (clauseId) => keccak256(toBytes(clauseId));

/**
 * The implicit clause `evaluate` prepends to every evaluation. No provider
 * declares it — the SLA validator rejects `id: 'delivery'` — which is exactly
 * why it can be matched by name here without colliding with a real clause.
 */
export const DELIVERY_CLAUSE = 'delivery';

/**
 * Turn a verdict's `failedClause` word back into a clause id, using the SLA the
 * service published.
 *
 * The chain stores a hash, not a string, so this is the only way back — and for
 * declared clauses it only works against the SLA in force. Four answers, all
 * meaningful:
 *
 *   - a clause id — that clause is what broke;
 *   - `'delivery'` — the implicit clause, so the provider did not deliver at
 *     all. Checked before the SLA because it is never in one;
 *   - `null` for the zero word — no clause was named. Either the verdict was a
 *     PASS, or judgement fell back to status alone and evaluated no clauses;
 *   - `'unknown'` — a non-zero hash matching nothing the SLA currently
 *     declares. That is not an error to hide: it means the provider has edited
 *     its SLA since this verdict, and the clause that was broken no longer
 *     exists under that id. Showing it as such is the honest reading.
 *
 * @param {string} failedClause the 32-byte word from the verdict
 * @param {SlaDocument|null} sla the service's SLA as published now
 * @returns {string|null} the clause id, `'delivery'`, `null`, or `'unknown'`
 */
export function matchFailedClause(failedClause, sla) {
  if (!failedClause || failedClause.toLowerCase() === NO_CLAUSE) return null;
  const target = failedClause.toLowerCase();
  if (clauseHash(DELIVERY_CLAUSE).toLowerCase() === target) return DELIVERY_CLAUSE;
  for (const clause of sla?.clauses ?? []) {
    if (clauseHash(clause.id).toLowerCase() === target) return clause.id;
  }
  return 'unknown';
}
