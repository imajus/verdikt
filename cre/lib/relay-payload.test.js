import { describe, expect, it } from 'vitest';
import { RESPONSE_BUDGET_BYTES, fitToBudget } from './relay-payload.js';

const REQUEST_ID = `0x${'ab'.repeat(32)}`;

/** @param {Partial<Record<string, unknown>>} [overrides] */
const result = (overrides = {}) => ({
  status: 200,
  body: '{"summary":"short"}',
  outcome: 'PASS',
  mode: 'sla',
  reason: null,
  clauses: [],
  tx: null,
  ...overrides
});

const bytes = (/** @type {string} */ text) => new TextEncoder().encode(text).length;

describe('fitToBudget', () => {
  it('leaves a normal payload exactly as it is', () => {
    const payload = JSON.parse(fitToBudget(REQUEST_ID, result()));
    expect(payload).toMatchObject({
      requestId: REQUEST_ID,
      status: 200,
      body: '{"summary":"short"}',
      bodyTruncated: false,
      outcome: 'PASS'
    });
  });

  it('carries the verdict fields through untouched', () => {
    const payload = JSON.parse(
      fitToBudget(REQUEST_ID, result({ outcome: 'FAIL', tx: '0xabc', clauses: [{ id: 'speed', pass: false }] }))
    );
    expect(payload.outcome).toBe('FAIL');
    expect(payload.tx).toBe('0xabc');
    expect(payload.clauses).toEqual([{ id: 'speed', pass: false }]);
  });

  it('records a missing body as an empty string rather than dropping the field', () => {
    const payload = JSON.parse(fitToBudget(REQUEST_ID, result({ body: undefined })));
    expect(payload.body).toBe('');
    expect(payload.bodyTruncated).toBe(false);
  });

  describe('when the body is too large', () => {
    it('trims it to fit and says so', () => {
      const payload = fitToBudget(REQUEST_ID, result({ body: 'a'.repeat(2000) }), 500);
      expect(bytes(payload)).toBeLessThanOrEqual(500);
      expect(JSON.parse(payload).bodyTruncated).toBe(true);
    });

    it('keeps as much of the body as the budget allows', () => {
      const payload = JSON.parse(fitToBudget(REQUEST_ID, result({ body: 'a'.repeat(2000) }), 500));
      // Not a token gesture: most of the budget goes to the body, and the
      // envelope is small.
      expect(payload.body.length).toBeGreaterThan(300);
    });

    // A character is not a byte, twice over — multibyte UTF-8, and JSON
    // escaping that can turn one character into six. A fixed character cap
    // that looks safe for ASCII is not safe for either.
    it('measures bytes, not characters, for multibyte text', () => {
      const payload = fitToBudget(REQUEST_ID, result({ body: '⛳'.repeat(2000) }), 500);
      expect(bytes(payload)).toBeLessThanOrEqual(500);
    });

    it('measures the escaped form, not the raw one', () => {
      // Each of these serializes as `\"`, two bytes for one character.
      const payload = fitToBudget(REQUEST_ID, result({ body: '"'.repeat(2000) }), 500);
      expect(bytes(payload)).toBeLessThanOrEqual(500);
    });

    it('measures control characters, which escape to six bytes each', () => {
      const payload = fitToBudget(REQUEST_ID, result({ body: ''.repeat(2000) }), 500);
      expect(bytes(payload)).toBeLessThanOrEqual(500);
    });

    it('still produces valid JSON, never a body cut mid-escape', () => {
      const payload = fitToBudget(REQUEST_ID, result({ body: '「テスト」'.repeat(500) }), 400);
      expect(() => JSON.parse(payload)).not.toThrow();
    });
  });

  // Nothing here can fix an envelope that does not fit by trimming a body, and
  // a truthful oversized payload beats a lie that fits.
  it('returns an oversized payload rather than a false one when the envelope alone is too big', () => {
    const clauses = Array.from({ length: 32 }, (_, i) => ({ id: `clause-${i}`, expected: 'x'.repeat(200) }));
    const payload = fitToBudget(REQUEST_ID, result({ body: 'a'.repeat(1000), clauses }), 500);
    expect(JSON.parse(payload).body).toBe('');
    expect(JSON.parse(payload).clauses).toHaveLength(32);
  });

  // The old cap was 20,000 characters, measured against a limit that governs
  // consensus observations — which this payload never becomes (#88).
  it('keeps a body far larger than the cap it replaced', () => {
    const payload = JSON.parse(fitToBudget(REQUEST_ID, result({ body: 'a'.repeat(60_000) })));
    expect(payload.body.length).toBe(60_000);
    expect(payload.bodyTruncated).toBe(false);
  });

  it('stays inside the production budget for a body larger than it', () => {
    const payload = fitToBudget(REQUEST_ID, result({ body: 'a'.repeat(500_000) }));
    expect(bytes(payload)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(JSON.parse(payload).bodyTruncated).toBe(true);
  });
});
