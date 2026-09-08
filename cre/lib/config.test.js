import { describe, expect, it } from 'vitest';
import { assertBlockTimeSeconds } from './config.js';

describe('assertBlockTimeSeconds', () => {
  it('accepts a positive number and returns it unchanged', () => {
    expect(assertBlockTimeSeconds(0.512)).toBe(0.512);
    expect(assertBlockTimeSeconds(12)).toBe(12);
  });

  it('coerces a numeric string — config loaders round-trip JSON as strings', () => {
    expect(assertBlockTimeSeconds('0.512')).toBe(0.512);
  });

  // The whole point of the guard: the field the workflow crashed on when unset.
  it('rejects an unset value loudly instead of yielding NaN downstream', () => {
    expect(() => assertBlockTimeSeconds(undefined)).toThrow(/blockTimeSeconds/);
    expect(() => assertBlockTimeSeconds(null)).toThrow(/blockTimeSeconds/);
  });

  it('rejects non-positive and non-finite values', () => {
    expect(() => assertBlockTimeSeconds(0)).toThrow(/positive/);
    expect(() => assertBlockTimeSeconds(-1)).toThrow(/positive/);
    expect(() => assertBlockTimeSeconds(NaN)).toThrow(/positive/);
    expect(() => assertBlockTimeSeconds(Infinity)).toThrow(/positive/);
  });

  it('rejects a non-numeric string rather than passing NaN through', () => {
    expect(() => assertBlockTimeSeconds('soon')).toThrow(/blockTimeSeconds/);
    expect(() => assertBlockTimeSeconds('')).toThrow(/blockTimeSeconds/);
  });
});
