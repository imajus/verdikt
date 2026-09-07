import { describe, expect, it } from 'vitest';
import { NO_DATA_SCORE, SCORE_SCALE, aggregateWindow } from './aggregate.js';

/** @param {{ pass?: number, fail?: number, down?: number }} counts */
const window = ({ pass = 0, fail = 0, down = 0 }) => [
  ...Array(pass).fill('PASS'),
  ...Array(fail).fill('FAIL'),
  ...Array(down).fill('DOWN')
];

describe('aggregateWindow', () => {
  it('scores a perfect window 1000 on both ratios', () => {
    expect(aggregateWindow(window({ pass: 10 }))).toMatchObject({ conformance: 1000, availability: 1000 });
  });

  it('splits conformance by responses that arrived', () => {
    expect(aggregateWindow(window({ pass: 3, fail: 1 })).conformance).toBe(750);
  });

  // A call that returned nothing says nothing about whether the body would
  // have conformed, so it must not drag the conformance ratio down.
  it('leaves DOWN out of the conformance denominator', () => {
    expect(aggregateWindow(window({ pass: 3, fail: 1, down: 96 })).conformance).toBe(750);
  });

  it('counts DOWN against availability and nothing else', () => {
    expect(aggregateWindow(window({ pass: 8, down: 2 }))).toMatchObject({ conformance: 1000, availability: 800 });
  });

  it('scores an empty window 1000, not 0', () => {
    // A service nobody called is presumed healthy. Getting this backwards
    // brands every new listing as broken before it serves a request.
    expect(aggregateWindow([])).toMatchObject({ conformance: NO_DATA_SCORE, availability: NO_DATA_SCORE });
  });

  it('reports a service that only ever went down as unavailable but not non-conforming', () => {
    // Nothing arrived, so nothing is known about body quality; availability is
    // what carries the outage.
    expect(aggregateWindow(window({ down: 5 }))).toMatchObject({ conformance: 1000, availability: 0 });
  });

  it('scores a service that only ever failed 0 on conformance', () => {
    expect(aggregateWindow(window({ fail: 5 }))).toMatchObject({ conformance: 0, availability: 1000 });
  });

  it('floors rather than rounds, so a near-miss never reads as perfect', () => {
    // 1999/2000 = 999.5. Rounding would publish 1000 for a service that failed.
    expect(aggregateWindow(window({ pass: 1999, fail: 1 })).conformance).toBe(999);
  });

  it('returns integers inside the published scale for every mix', () => {
    for (const counts of [
      { pass: 1 },
      { fail: 1 },
      { down: 1 },
      { pass: 1, fail: 1, down: 1 },
      { pass: 7, fail: 3, down: 11 },
      { pass: 999, fail: 1, down: 1000 }
    ]) {
      const scores = aggregateWindow(window(counts));
      for (const value of [scores.conformance, scores.availability]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(SCORE_SCALE);
      }
    }
  });

  it('reports the counts the ratios were derived from', () => {
    expect(aggregateWindow(window({ pass: 2, fail: 3, down: 4 })).counts).toEqual({
      pass: 2,
      fail: 3,
      down: 4,
      total: 9
    });
  });

  it('accepts verdict records as well as bare outcomes', () => {
    expect(aggregateWindow([{ outcome: 'PASS' }, { outcome: 'FAIL' }]).conformance).toBe(500);
  });

  it('refuses an outcome it cannot classify rather than quietly skewing a denominator', () => {
    expect(() => aggregateWindow(['PASS', /** @type {never} */ ('FAIL_CONFORMANCE')])).toThrow(/unknown outcome/);
  });
});
