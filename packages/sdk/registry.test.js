import { describe, expect, it } from 'vitest';
import {
  DELIVERY_CLAUSE,
  NO_CLAUSE,
  OUTCOME_ORDINAL,
  STATUS_ORDINAL,
  clauseHash,
  matchFailedClause,
  outcomeFromOrdinal,
  outcomeToOrdinal,
  serviceIdOf,
  statusFromOrdinal
} from './registry.js';

describe('outcome and status ordinals', () => {
  // Mirrored in IVerdiktRegistry.Outcome / .Status. Changing one side without
  // the other silently reclassifies a FAIL as a PASS.
  it('pins the ABI ordinals', () => {
    expect(OUTCOME_ORDINAL).toEqual({ PASS: 0, FAIL: 1, DOWN: 2 });
    expect(STATUS_ORDINAL).toEqual({ NONE: 0, ACTIVE: 1, SUSPENDED: 2, DEREGISTERED: 3 });
  });

  it('round-trips every outcome and status', () => {
    for (const [name, ordinal] of Object.entries(OUTCOME_ORDINAL)) {
      expect(outcomeFromOrdinal(ordinal)).toBe(name);
      expect(outcomeToOrdinal(/** @type {SlaOutcome} */ (name))).toBe(ordinal);
    }
    for (const [name, ordinal] of Object.entries(STATUS_ORDINAL)) {
      expect(statusFromOrdinal(ordinal)).toBe(name);
    }
  });

  it('refuses an ordinal outside the enum rather than guessing', () => {
    expect(() => outcomeFromOrdinal(3)).toThrow();
    expect(() => outcomeFromOrdinal(-1)).toThrow();
    expect(() => statusFromOrdinal(4)).toThrow();
    expect(() => outcomeToOrdinal(/** @type {SlaOutcome} */ ('FAIL_CONFORMANCE'))).toThrow();
  });
});

describe('serviceIdOf', () => {
  /**
   * The same two vectors `contracts/test/VerdiktRegistry.t.sol` asserts against
   * `IVerdiktRegistry.serviceIdOf`. If these ever diverge, a service's Arc id
   * stops matching its ENS subname and its route.
   */
  it('agrees with the contract on the shared vectors', () => {
    expect(serviceIdOf('weather')).toBe('0x00840d14970f593887dc91256f2e2f1380aa176569b6c84f16d7f2ced5965666');
    expect(serviceIdOf('weather-lite')).toBe('0x899bec1a6fac1010f453e04f5b2827fdd8a3eeeabd5f39a1c54f9539a116a887');
  });

  it('rejects slugs the registry would reject', () => {
    for (const slug of ['', 'Weather', 'weather.eth', 'weather_x', '-weather', 'weather-', 'wéather', 'a'.repeat(64)]) {
      expect(() => serviceIdOf(slug), slug).toThrow();
    }
  });

  it('accepts the labels a provider can actually route and name', () => {
    for (const slug of ['a', 'weather', 'weather-lite', 'x1', 'a'.repeat(63)]) {
      expect(serviceIdOf(slug), slug).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});


describe('matchFailedClause', () => {
  /** @type {SlaDocument} */
  const sla = /** @type {any} */ ({
    version: 1,
    clauses: [
      { id: 'shape', type: 'schema', schema: { type: 'object' } },
      { id: 'responds-within-5s', type: 'latency', maxMs: 5000 }
    ]
  });

  it('resolves a hash back to the clause id the provider declared', () => {
    expect(matchFailedClause(clauseHash('responds-within-5s'), sla)).toBe('responds-within-5s');
  });

  /**
   * The implicit clause is prepended by `evaluate` and is in no SLA — the
   * validator rejects `id: "delivery"` — so it has to be matched by name.
   * Falling through to the declared ids would report every outage as an edit.
   */
  it('resolves the implicit delivery clause without it being in the SLA', () => {
    expect(matchFailedClause(clauseHash(DELIVERY_CLAUSE), sla)).toBe(DELIVERY_CLAUSE);
    expect(matchFailedClause(clauseHash(DELIVERY_CLAUSE), null)).toBe(DELIVERY_CLAUSE);
  });

  it('reads the zero word as "no clause was named", not as a miss', () => {
    expect(matchFailedClause(NO_CLAUSE, sla)).toBeNull();
    expect(matchFailedClause(NO_CLAUSE.toUpperCase().replace('0X', '0x'), sla)).toBeNull();
  });

  /**
   * A verdict is final and the SLA behind it is not. Reporting a clause the SLA
   * no longer declares as absent would hide the provider's edit, which is the
   * one thing a reader looking at an old verdict needs to know.
   */
  it('reports a clause the SLA no longer declares as unknown, not as absent', () => {
    expect(matchFailedClause(clauseHash('removed-since'), sla)).toBe('unknown');
    expect(matchFailedClause(clauseHash('shape'), null)).toBe('unknown');
  });

  it('does not care how the hash was cased on the way in', () => {
    const upper = /** @type {string} */ (clauseHash('shape')).toUpperCase().replace('0X', '0x');
    expect(matchFailedClause(upper, sla)).toBe('shape');
  });
});
