import { describe, expect, it } from 'vitest';
import { assertBlockTimeSeconds, assertLogChunkBlocks } from './config.js';

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

describe('assertLogChunkBlocks', () => {
  it('accepts a number or a numeric string and returns blocks as a bigint', () => {
    expect(assertLogChunkBlocks(30_000)).toBe(30_000n);
    expect(assertLogChunkBlocks('30000')).toBe(30_000n);
  });

  // Unlike blockTimeSeconds there IS a safe value, so an absent field is not
  // an error: 10,000 is accepted by every Arc RPC measured.
  it('defaults to the portable chunk width when unset', () => {
    expect(assertLogChunkBlocks(undefined)).toBe(10_000n);
    expect(assertLogChunkBlocks(null)).toBe(10_000n);
    expect(assertLogChunkBlocks('')).toBe(10_000n);
  });

  it('rejects values that would make the chunker loop forever', () => {
    expect(() => assertLogChunkBlocks(0)).toThrow(/positive/);
    expect(() => assertLogChunkBlocks(-1)).toThrow(/positive/);
  });

  it('rejects a fractional or non-numeric value rather than drifting off block boundaries', () => {
    expect(() => assertLogChunkBlocks(1.5)).toThrow(/logChunkBlocks/);
    expect(() => assertLogChunkBlocks('lots')).toThrow(/logChunkBlocks/);
  });
});
