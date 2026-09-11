import { describe, expect, it } from 'vitest';
import { blockRangeChunks } from './log-range.js';

describe('blockRangeChunks', () => {
  it('returns one chunk when the range already fits', () => {
    expect(blockRangeChunks(100n, 200n, 10_000n)).toEqual([{ from: 100n, to: 200n }]);
  });

  it('treats both ends as inclusive, like eth_getLogs', () => {
    // 10 blocks of room, 10 blocks asked for: exactly one chunk, not two.
    expect(blockRangeChunks(1n, 10n, 10n)).toEqual([{ from: 1n, to: 10n }]);
  });

  it('splits a range wider than the cap', () => {
    expect(blockRangeChunks(1n, 25n, 10n)).toEqual([
      { from: 1n, to: 10n },
      { from: 11n, to: 20n },
      { from: 21n, to: 25n }
    ]);
  });

  it('never overlaps or skips a block across chunk boundaries', () => {
    const chunks = blockRangeChunks(60_860_488n, 61_599_019n, 10_000n);
    expect(chunks[0].from).toBe(60_860_488n);
    expect(chunks.at(-1)?.to).toBe(61_599_019n);
    for (let i = 1; i < chunks.length; i += 1) {
      // The whole point: a gap loses a verdict, an overlap counts one twice,
      // and both are invisible in the published ratio.
      expect(chunks[i].from).toBe(chunks[i - 1].to + 1n);
    }
    const covered = chunks.reduce((total, chunk) => total + (chunk.to - chunk.from + 1n), 0n);
    expect(covered).toBe(61_599_019n - 60_860_488n + 1n);
  });

  it('keeps every chunk within the cap', () => {
    for (const chunk of blockRangeChunks(1n, 1_000_000n, 10_000n)) {
      expect(chunk.to - chunk.from + 1n).toBeLessThanOrEqual(10_000n);
    }
  });

  it('yields a single-block chunk for a single-block range', () => {
    expect(blockRangeChunks(7n, 7n, 10_000n)).toEqual([{ from: 7n, to: 7n }]);
  });

  it('yields nothing when the head has not reached the start block', () => {
    // Not an error: a registry deployed in a block the head has not passed.
    expect(blockRangeChunks(100n, 99n, 10_000n)).toEqual([]);
  });

  it('rejects a non-positive cap rather than looping forever', () => {
    expect(() => blockRangeChunks(1n, 10n, 0n)).toThrow(/must be positive/);
  });
});
