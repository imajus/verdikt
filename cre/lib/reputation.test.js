import { describe, expect, it } from 'vitest';
import { WINDOW_SECONDS, reputationForWindow, scoresChanged } from './reputation.js';

const NOW = 1_800_000_000;

/**
 * @param {string} slug
 * @param {ServiceStatus} [status]
 * @returns {ScoredService}
 */
const service = (slug, status = 'ACTIVE') => ({ serviceId: `0x${slug}`, slug, status });

/**
 * @param {string} slug
 * @param {SlaOutcome} outcome
 * @param {number} [agoSeconds]
 * @returns {WindowVerdict}
 */
const verdict = (slug, outcome, agoSeconds = 60) => ({
  serviceId: `0x${slug}`,
  outcome,
  timestamp: NOW - agoSeconds
});

/**
 * @param {ScoredService[]} services
 * @param {WindowVerdict[]} verdicts
 * @param {number} [now]
 */
const run = (services, verdicts, now = NOW) => reputationForWindow({ services, verdicts, now });

describe('reputationForWindow', () => {
  it('scores each service from its own verdicts', () => {
    const scores = run(
      [service('weather'), service('prices')],
      [
        verdict('weather', 'PASS'),
        verdict('weather', 'PASS'),
        verdict('weather', 'FAIL'),
        verdict('prices', 'DOWN')
      ]
    );
    expect(scores).toEqual([
      expect.objectContaining({ slug: 'weather', conformance: 666, availability: 1000 }),
      expect.objectContaining({ slug: 'prices', conformance: 1000, availability: 0 })
    ]);
  });

  // The reason the list is built from services, not from verdicts: a
  // zero-traffic service can only be *published* as 1000 if it appears here.
  // Deriving the list from verdicts would skip exactly those services and
  // leave whatever stale number they last had standing.
  it('includes a service with no verdicts at all, scored 1000', () => {
    const scores = run([service('quiet')], []);
    expect(scores).toEqual([
      expect.objectContaining({ slug: 'quiet', conformance: 1000, availability: 1000, counts: { pass: 0, fail: 0, down: 0, total: 0 } })
    ]);
  });

  it('drops verdicts older than the trailing window', () => {
    const scores = run(
      [service('weather')],
      [verdict('weather', 'FAIL', WINDOW_SECONDS + 1), verdict('weather', 'PASS', 10)]
    );
    expect(scores[0]).toMatchObject({ conformance: 1000, counts: { pass: 1, fail: 0, down: 0, total: 1 } });
  });

  it('uses a half-open window so two runs never both count the same boundary event', () => {
    const exactlyAtEdge = run([service('weather')], [verdict('weather', 'FAIL', WINDOW_SECONDS)]);
    expect(exactlyAtEdge[0].counts.total).toBe(0);
    const justInside = run([service('weather')], [verdict('weather', 'FAIL', WINDOW_SECONDS - 1)]);
    expect(justInside[0].counts.total).toBe(1);
  });

  it('ignores a verdict timestamped in the future', () => {
    expect(run([service('weather')], [verdict('weather', 'FAIL', -60)])[0].counts.total).toBe(0);
  });

  it('still scores a suspended service — it is still listed', () => {
    const scores = run([service('drained', 'SUSPENDED')], [verdict('drained', 'FAIL')]);
    expect(scores).toHaveLength(1);
    expect(scores[0].conformance).toBe(0);
  });

  it('drops a deregistered service — its bond has gone home and it is not a listing', () => {
    expect(run([service('gone', 'DEREGISTERED')], [verdict('gone', 'PASS')])).toEqual([]);
  });

  it('ignores a verdict for a service that is not a live listing', () => {
    // Nothing to publish to: it has no subname in the marketplace.
    const scores = run([service('weather')], [verdict('weather', 'PASS'), verdict('stranger', 'FAIL')]);
    expect(scores[0].counts).toEqual({ pass: 1, fail: 0, down: 0, total: 1 });
  });

  it('refuses to run without a timestamp rather than reading a clock', () => {
    expect(() => reputationForWindow({ services: [], verdicts: [], now: NaN })).toThrow(/Unix timestamp/);
  });

  it('is deterministic for the same inputs', () => {
    const services = [service('weather')];
    const verdicts = [verdict('weather', 'PASS'), verdict('weather', 'FAIL')];
    expect(run(services, verdicts)).toEqual(run(services, verdicts));
  });
});

describe('scoresChanged', () => {
  const computed = { serviceId: '0x1', slug: 'weather', conformance: 900, availability: 1000, counts: { pass: 9, fail: 1, down: 0, total: 10 } };

  it('treats a never-published service as changed', () => {
    expect(scoresChanged(computed, { conformance: null, availability: null })).toBe(true);
  });

  it('skips a write when neither ratio moved', () => {
    expect(scoresChanged(computed, { conformance: 900, availability: 1000 })).toBe(false);
  });

  it('writes when either ratio moved', () => {
    expect(scoresChanged(computed, { conformance: 901, availability: 1000 })).toBe(true);
    expect(scoresChanged(computed, { conformance: 900, availability: 999 })).toBe(true);
  });
});
