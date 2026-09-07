import { describe, expect, it } from 'vitest';
import { evaluate, evaluateStatusOnly, parseSla } from './index.js';
import HONEST_SLA from '../../fixtures/sla/honest.json' with { type: 'json' };
import VIOLATING_SLA from '../../fixtures/sla/violating.json' with { type: 'json' };
import VECTORS from './vectors.json' with { type: 'json' };

/**
 * The vectors carry `paidAmountMinorUnits` as a decimal string because JSON has
 * no integer type wide enough to be safe. This is the only place that string
 * becomes a bigint — everywhere else in the system `decodePayment` does it.
 * @param {Record<string, unknown>} observation
 * @returns {SlaObservation}
 */
const materialise = ({ paidAmountMinorUnits, ...rest }) => ({
  .../** @type {Omit<SlaObservation, 'paidAmount'>} */ (/** @type {unknown} */ (rest)),
  paidAmount: BigInt(/** @type {string} */ (paidAmountMinorUnits))
});

describe('conformance vectors', () => {
  it('carries every case the port would have to reproduce', () => {
    expect(VECTORS.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of VECTORS.cases) {
    it(testCase.name, () => {
      const observation = materialise(/** @type {Record<string, unknown>} */ (testCase.observation));
      const run = () =>
        testCase.mode === 'statusOnly'
          ? evaluateStatusOnly(observation)
          : evaluate(/** @type {SlaDocument} */ (/** @type {unknown} */ (testCase.sla)), observation);

      if ('throws' in testCase.expect) {
        expect(run).toThrow();
        return;
      }
      const result = run();
      expect(result.outcome).toBe(testCase.expect.outcome);
      expect(result.clauses.map((clause) => clause.id)).toEqual(testCase.expect.clauses.map((clause) => clause.id));
      testCase.expect.clauses.forEach((expected, index) => {
        expect(result.clauses[index]).toMatchObject(expected);
      });
    });
  }
});

describe('demo SLA fixtures', () => {
  const response = {
    latitude: 52.52,
    longitude: 13.41,
    current: { time: '2026-09-07T10:00', interval: 900, temperature_2m: 12.5, wind_speed_10m: 9.1 }
  };
  /** @type {SlaObservation} */
  const observation = { status: 200, headers: {}, body: response, latencyMs: 420, paidAmount: 2500n };

  it('both parse as valid SLA documents', () => {
    expect(parseSla(JSON.stringify(HONEST_SLA))).toBeTruthy();
    expect(parseSla(JSON.stringify(VIOLATING_SLA))).toBeTruthy();
  });

  it('the honest SLA passes against the service it describes', () => {
    expect(evaluate(/** @type {SlaDocument} */ (/** @type {unknown} */ (HONEST_SLA)), observation).outcome).toBe('PASS');
  });

  it('the violating twin fails the same response on both of its impossible clauses', () => {
    const result = evaluate(/** @type {SlaDocument} */ (/** @type {unknown} */ (VIOLATING_SLA)), observation);
    expect(result.outcome).toBe('FAIL');
    expect(result.clauses.filter((clause) => !clause.pass).map((clause) => clause.id)).toEqual([
      'current-weather-shape',
      'responds-within-5ms'
    ]);
  });
});
