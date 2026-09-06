import { describe, expect, it } from 'vitest';
import { SLA_TEXT } from '@verdikt/fixtures';
import { JUDGEMENT_MODE, judge, observationFrom, shouldWriteVerdict } from './judge.js';

/** @returns {SlaObservation} */
const observe = (overrides = {}) => ({
  status: 200,
  headers: {},
  body: { latitude: 52.52, longitude: 13.41, current: { time: 't', temperature_2m: 12.5, wind_speed_10m: 9.1 } },
  latencyMs: 400,
  paidAmount: 2500n,
  ...overrides
});

describe('judge — with a readable SLA', () => {
  it('applies the provider’s own clauses', () => {
    const result = judge(SLA_TEXT.honest, observe());
    expect(result).toMatchObject({ mode: JUDGEMENT_MODE.SLA, outcome: 'PASS', fallbackReason: null });
    expect(result.clauses.length).toBeGreaterThan(1);
  });

  it('fails the call when a clause breaks, and says which', () => {
    const result = judge(SLA_TEXT.violating, observe());
    expect(result.outcome).toBe('FAIL');
    expect(result.clauses.filter((clause) => !clause.pass).map((clause) => clause.id)).toContain('responds-within-5ms');
  });

  it('is DOWN when nothing came back', () => {
    const result = judge(SLA_TEXT.honest, observe({ status: null, body: null, transportError: 'ETIMEDOUT' }));
    expect(result).toMatchObject({ mode: JUDGEMENT_MODE.SLA, outcome: 'DOWN' });
  });
});

describe('judge — when the SLA cannot be used', () => {
  // Recording a failure when the provider was fine takes money from their bond
  // with no way to appeal, and an unreadable SLA is Verdikt's problem, not
  // theirs. So none of these produce a verdict out of clause logic.
  const unusable = [
    ['unreadable from ENS', null],
    ['an empty record', ''],
    ['not JSON at all', '{'],
    ['JSON that is not an SLA', '{"version":2,"clauses":[]}'],
    ['an SLA with no clauses', '{"version":1,"clauses":[]}'],
    ['a clause type we do not implement', '{"version":1,"clauses":[{"id":"x","type":"throughput","minRps":1}]}']
  ];

  for (const [label, slaText] of unusable) {
    it(`falls back to status-only on ${label}`, () => {
      const result = judge(/** @type {string|null} */ (slaText), observe());
      expect(result.mode).toBe(JUDGEMENT_MODE.STATUS_ONLY);
      expect(result.fallbackReason).toBeTruthy();
      expect(result.clauses).toEqual([]);
    });
  }

  it('scores 2xx as PASS and 5xx as FAIL', () => {
    expect(judge(null, observe({ status: 200 })).outcome).toBe('PASS');
    expect(judge(null, observe({ status: 503 })).outcome).toBe('FAIL');
  });

  it('writes no verdict at all on 4xx', () => {
    // The carve-out that stops an agent farming refunds out of provider bonds
    // during a Verdikt-side outage.
    const result = judge(null, observe({ status: 402 }));
    expect(result.outcome).toBeNull();
    expect(shouldWriteVerdict(result)).toBe(false);
  });

  it('never manufactures a PASS from an unreadable SLA', () => {
    // The dangerous shape of this bug is the opposite one — a fallback that
    // defaults to PASS would let a provider break its SLA for free by making
    // the record unreadable.
    expect(judge('{', observe({ status: 500 })).outcome).toBe('FAIL');
  });

  it('is still DOWN when nothing came back', () => {
    expect(judge(null, observe({ status: null, body: null })).outcome).toBe('DOWN');
  });
});

describe('shouldWriteVerdict', () => {
  it('gates the Arc write, since onReport cannot express "no verdict"', () => {
    expect(shouldWriteVerdict(judge(SLA_TEXT.honest, observe()))).toBe(true);
    expect(shouldWriteVerdict(judge(null, observe({ status: 404 })))).toBe(false);
  });
});

describe('observationFrom', () => {
  it('parses a JSON body for the schema clause to walk', () => {
    expect(observationFrom({ status: 200, bodyText: '{"a":1}', latencyMs: 5, paidAmount: 1n }).body).toEqual({ a: 1 });
  });

  it('hands over an unparseable body as the raw string rather than discarding it', () => {
    // A schema clause of {"type":"string"} is legitimate, and throwing here
    // would turn a plain-text response into a DOWN it never was.
    const observation = observationFrom({ status: 200, bodyText: 'plain text', latencyMs: 5, paidAmount: 1n });
    expect(observation.body).toBe('plain text');
    expect(observation.status).toBe(200);
  });

  it('carries the transport error through only when there was one', () => {
    expect(observationFrom({ status: 200, bodyText: '{}', latencyMs: 1, paidAmount: 1n }).transportError).toBeUndefined();
    expect(
      observationFrom({ status: null, latencyMs: 30000, paidAmount: 1n, transportError: 'ECONNRESET' }).transportError
    ).toBe('ECONNRESET');
  });

  it('produces something the engine accepts', () => {
    const observation = observationFrom({ status: 200, bodyText: '{}', latencyMs: 10, paidAmount: 2500n });
    expect(() => judge(SLA_TEXT.honest, observation)).not.toThrow();
  });
});
