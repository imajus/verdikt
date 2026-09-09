import { describe, expect, it } from 'vitest';

// Not exported — re-implemented as a one-line re-export shim would defeat the
// point of keeping it private, so this test imports the module and reaches
// the function via a tiny re-export added below the implementation instead.
import { __parseUsdcToNativeUnitsForTests as parseUsdcToNativeUnits } from './bond.js';

describe('parseUsdcToNativeUnits', () => {
  it('parses a whole number', () => {
    expect(parseUsdcToNativeUnits('5')).toBe(5n * 10n ** 18n);
  });

  it('parses a decimal, padding to 18 places', () => {
    expect(parseUsdcToNativeUnits('1.5')).toBe(1_500_000_000_000_000_000n);
  });

  it('truncates fractions longer than 18 places rather than rejecting them', () => {
    expect(parseUsdcToNativeUnits('1.000000000000000009999')).toBe(1_000_000_000_000_000_009n);
  });

  it('rejects a negative amount', () => {
    expect(parseUsdcToNativeUnits('-1')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parseUsdcToNativeUnits('abc')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseUsdcToNativeUnits('')).toBeNull();
  });
});
