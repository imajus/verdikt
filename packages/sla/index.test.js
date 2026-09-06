import { describe, expect, it } from 'vitest';
import { OUTCOME, evaluate, evaluateStatusOnly, parseSla } from './index.js';

/**
 * @param {...SlaClause} clauses
 * @returns {SlaDocument}
 */
const sla = (...clauses) => ({ version: 1, clauses });

/** @type {SlaSchemaClause} */
const schemaClause = {
  id: 'shape',
  type: 'schema',
  schema: {
    type: 'object',
    required: ['current'],
    properties: {
      current: { type: 'object', required: ['temperature_2m'], properties: { temperature_2m: { type: 'number' } } }
    }
  }
};
/** @type {SlaLatencyClause} */
const latencyClause = { id: 'speed', type: 'latency', maxMs: 2000 };
/** @type {SlaPriceRangeClause} */
const priceClause = { id: 'price', type: 'priceRange', minMinorUnits: '1000', maxMinorUnits: '5000', asset: 'USDC' };

/**
 * Deliberately-malformed documents. Untyped on purpose — the point of each is
 * that it would not typecheck as an `SlaDocument`, and the engine still has to
 * reject it at run time because the SLA arrives as text from ENS.
 * @param {...unknown} clauses
 */
const badSla = (...clauses) => ({ version: 1, clauses });

const FULL_SLA = sla(schemaClause, latencyClause, priceClause);

/** @returns {SlaObservation} */
const observe = (overrides = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: { current: { temperature_2m: 12.5 } },
  latencyMs: 100,
  paidAmount: 2500n,
  ...overrides
});

/**
 * @param {SlaEvaluation} result
 * @param {string} id
 * @returns {SlaClauseResult}
 */
const byId = (result, id) => {
  const clause = result.clauses.find((candidate) => candidate.id === id);
  if (!clause) throw new Error(`no clause result with id "${id}"`);
  return clause;
};

describe('evaluate — outcomes', () => {
  it('PASSes when every clause holds', () => {
    const result = evaluate(FULL_SLA, observe());
    expect(result.outcome).toBe(OUTCOME.PASS);
    expect(result.clauses.every((c) => c.pass)).toBe(true);
  });

  it('FAILs when a response arrived and broke a clause', () => {
    const result = evaluate(FULL_SLA, observe({ body: { current: { temperature_2m: 'warm' } } }));
    expect(result.outcome).toBe(OUTCOME.FAIL);
    expect(byId(result, 'shape').pass).toBe(false);
    expect(byId(result, 'speed').pass).toBe(true);
  });

  it('is DOWN when no usable response came back', () => {
    const result = evaluate(FULL_SLA, observe({ status: null, body: null, transportError: 'ETIMEDOUT' }));
    expect(result.outcome).toBe(OUTCOME.DOWN);
    expect(byId(result, 'delivery').actual).toContain('ETIMEDOUT');
  });

  it('does not evaluate declared clauses when nothing arrived', () => {
    const result = evaluate(FULL_SLA, observe({ status: null, body: null }));
    expect(result.clauses.map((c) => c.id)).toEqual(['delivery']);
  });
});

describe('evaluate — the implicit delivery clause', () => {
  // A provider whose SLA declares only a latency bound must not collect a PASS
  // for a 500 returned in 5ms. The fallback already scores 5xx as FAIL; the
  // full path being more lenient than the fallback would be backwards.
  it('FAILs a 5xx even when every declared clause holds', () => {
    const result = evaluate(sla(latencyClause), observe({ status: 503, body: {}, latencyMs: 5 }));
    expect(result.outcome).toBe(OUTCOME.FAIL);
    expect(byId(result, 'delivery').pass).toBe(false);
    expect(byId(result, 'speed').pass).toBe(true);
  });

  // A 4xx is left to the provider's own clauses: with a readable SLA the
  // provider has the pen and can declare what its error bodies look like. The
  // refund cap (spec §3) is what keeps garbage-request farming break-even.
  it('leaves a 4xx to the declared clauses', () => {
    const result = evaluate(sla(latencyClause), observe({ status: 400, body: { error: 'bad' }, latencyMs: 5 }));
    expect(result.outcome).toBe(OUTCOME.PASS);
    expect(byId(result, 'delivery').pass).toBe(true);
  });

  it('refuses an SLA that reuses the reserved clause id', () => {
    expect(() => evaluate(sla({ id: 'delivery', type: 'latency', maxMs: 10 }), observe())).toThrow(/reserved/);
  });
});

describe('evaluate — boundaries', () => {
  it('passes latency exactly at the limit and fails one past it', () => {
    expect(evaluate(sla(latencyClause), observe({ latencyMs: 2000 })).outcome).toBe(OUTCOME.PASS);
    expect(evaluate(sla(latencyClause), observe({ latencyMs: 2001 })).outcome).toBe(OUTCOME.FAIL);
  });

  it('passes price exactly at both bounds and fails just outside', () => {
    expect(evaluate(sla(priceClause), observe({ paidAmount: 1000n })).outcome).toBe(OUTCOME.PASS);
    expect(evaluate(sla(priceClause), observe({ paidAmount: 5000n })).outcome).toBe(OUTCOME.PASS);
    expect(evaluate(sla(priceClause), observe({ paidAmount: 999n })).outcome).toBe(OUTCOME.FAIL);
    expect(evaluate(sla(priceClause), observe({ paidAmount: 5001n })).outcome).toBe(OUTCOME.FAIL);
  });

  it('compares price beyond Number.MAX_SAFE_INTEGER without losing precision', () => {
    const huge = sla({
      id: 'price',
      type: 'priceRange',
      minMinorUnits: '9007199254740993',
      maxMinorUnits: '9007199254740995',
      asset: 'USDC'
    });
    expect(evaluate(huge, observe({ paidAmount: 9007199254740994n })).outcome).toBe(OUTCOME.PASS);
    expect(evaluate(huge, observe({ paidAmount: 9007199254740992n })).outcome).toBe(OUTCOME.FAIL);
  });
});

describe('evaluate — clause detail', () => {
  it('reports expected and actual for the dashboard', () => {
    const result = evaluate(sla(latencyClause), observe({ latencyMs: 2500 }));
    expect(byId(result, 'speed')).toMatchObject({ type: 'latency', pass: false, expected: '<= 2000ms', actual: '2500ms' });
  });

  it('names the failing member of a schema clause', () => {
    const result = evaluate(sla(schemaClause), observe({ body: { current: { temperature_2m: 'warm' } } }));
    expect(byId(result, 'shape').expected).toContain('/current/temperature_2m');
    expect(byId(result, 'shape').actual).toContain('string');
  });

  it('preserves declared clause order after the implicit delivery clause', () => {
    expect(evaluate(FULL_SLA, observe()).clauses.map((c) => c.id)).toEqual(['delivery', 'shape', 'speed', 'price']);
  });
});

describe('evaluate — throws so the caller takes the status-only fallback', () => {
  const cases = [
    ['a non-object SLA', 'not an sla'],
    ['a wrong version', { version: 2, clauses: [latencyClause] }],
    ['a missing clause list', { version: 1 }],
    ['an empty clause list', { version: 1, clauses: [] }],
    ['an unknown clause type', badSla({ id: 'x', type: 'throughput', minRps: 5 })],
    ['a clause missing a required field', badSla({ id: 'x', type: 'latency' })],
    ['a clause with an unexpected field', badSla({ id: 'x', type: 'latency', maxMs: 1, grace: 5 })],
    ['duplicate clause ids', sla(latencyClause, latencyClause)],
    ['a non-integer price bound', sla({ ...priceClause, minMinorUnits: '10.5' })],
    ['a negative price bound', sla({ ...priceClause, minMinorUnits: '-1' })],
    ['an inverted price range', sla({ ...priceClause, minMinorUnits: '5000', maxMinorUnits: '1000' })],
    ['an unsupported JSON Schema keyword', sla({ id: 'x', type: 'schema', schema: { type: 'string', pattern: '^a' } })]
  ];
  for (const [label, document] of cases) {
    it(`throws on ${label}`, () => {
      expect(() => evaluate(/** @type {never} */ (document), observe())).toThrow();
    });
  }

  it('throws on a malformed observation rather than guessing', () => {
    expect(() => evaluate(FULL_SLA, observe({ paidAmount: 2500 }))).toThrow(/paidAmount/);
    expect(() => evaluate(FULL_SLA, observe({ latencyMs: -1 }))).toThrow(/latencyMs/);
    expect(() => evaluate(FULL_SLA, observe({ status: 99 }))).toThrow(/status/);
  });
});

describe('parseSla', () => {
  it('parses and validates in one step', () => {
    expect(parseSla(JSON.stringify(FULL_SLA))).toEqual(FULL_SLA);
  });

  it('throws on text that is not JSON', () => {
    expect(() => parseSla('{')).toThrow();
  });

  it('throws on JSON that is not an SLA', () => {
    expect(() => parseSla('{"version":1}')).toThrow();
  });
});

describe('evaluateStatusOnly', () => {
  it('scores 2xx as PASS', () => {
    expect(evaluateStatusOnly(observe({ status: 204 })).outcome).toBe(OUTCOME.PASS);
  });

  it('scores 5xx as FAIL', () => {
    expect(evaluateStatusOnly(observe({ status: 503 })).outcome).toBe(OUTCOME.FAIL);
  });

  it('writes no verdict at all on 4xx', () => {
    // The carve-out that stops an agent farming refunds with deliberate garbage.
    expect(evaluateStatusOnly(observe({ status: 404 })).outcome).toBeNull();
  });

  it('scores no usable response as DOWN', () => {
    expect(evaluateStatusOnly(observe({ status: null })).outcome).toBe(OUTCOME.DOWN);
  });

  it('declines to judge anything outside 2xx/5xx', () => {
    expect(evaluateStatusOnly(observe({ status: 301 })).outcome).toBeNull();
    expect(evaluateStatusOnly(observe({ status: 100 })).outcome).toBeNull();
  });

  it('reports no clause detail — it has no SLA to report against', () => {
    expect(evaluateStatusOnly(observe()).clauses).toEqual([]);
  });
});

describe('determinism', () => {
  it('is unaffected by key insertion order in the SLA or the body', () => {
    const forwards = evaluate(
      { version: 1, clauses: [schemaClause, latencyClause] },
      observe({ body: { current: { temperature_2m: 1, wind: 2 } } })
    );
    const backwards = evaluate(
      { clauses: [schemaClause, latencyClause], version: 1 },
      observe({ body: { current: { wind: 2, temperature_2m: 1 } } })
    );
    expect(forwards).toEqual(backwards);
  });

  it('returns the same result for the same input across repeated calls', () => {
    const first = evaluate(FULL_SLA, observe({ latencyMs: 2000, paidAmount: 5000n }));
    const second = evaluate(FULL_SLA, observe({ latencyMs: 2000, paidAmount: 5000n }));
    expect(first).toEqual(second);
  });

  it('never mutates its inputs', () => {
    const snapshot = JSON.stringify(FULL_SLA);
    const document = JSON.parse(snapshot);
    evaluate(document, observe());
    expect(JSON.stringify(document)).toBe(snapshot);
  });
});
