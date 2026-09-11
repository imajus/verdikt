// Startup validation for the aggregate workflow's config (Specification.md §1;
// Tasks.md 3.2).
//
// The workflow's `Config` is a TypeScript type. It is erased at compile time,
// so nothing checks `config.staging.json` against it at runtime — the same
// reason `judge.js` and `reputation.js` live here under vitest rather than in
// the untested `.ts` plumbing (Spike B, CRE-1).
//
// One field is load-bearing and fails in the worst way when wrong.
// `blockTimeSeconds` divides the trailing window into a `fromBlock` and dates
// every log the run reads. Unset, it makes `Math.ceil(WINDOW / undefined)`
// NaN, and `BigInt(NaN)` throws a `RangeError` thousands of lines from the
// cause; merely wrong, it shifts the window with no error at all — a silent,
// stale number under every provider's name. So it fails loudly here, at
// startup, next to the chain-selector checks, rather than being papered over
// with a guessed default.
//
// Pure: throws on bad input, returns the validated value otherwise. No clock,
// no I/O.

/**
 * Validate the aggregate's nominal block time.
 *
 * Accepts a number, or a numeric string (config loaders round-trip JSON and
 * sometimes hand back everything as strings). Rejects anything that is not a
 * positive, finite number of seconds.
 *
 * @param {unknown} value — `config.blockTimeSeconds`
 * @returns {number} the validated, positive block time in seconds
 */
export function assertBlockTimeSeconds(value) {
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `aggregate config: blockTimeSeconds must be a positive number of seconds, got ${JSON.stringify(value)}`
    );
  }
  return seconds;
}

/**
 * Validate the maximum blocks per `eth_getLogs` call.
 *
 * Unlike `blockTimeSeconds` this one fails loudly on its own — an oversized
 * range is rejected by the RPC (`requested range too large`) rather than
 * quietly answered — so the validation here is about the *other* direction:
 * a zero or negative value would make `blockRangeChunks` loop forever, and a
 * fractional one would drift off whole-block boundaries.
 *
 * Defaulted rather than required, because unlike the block time there is a
 * safe value: 10,000 is the smaller of the two measured caps on Arc's
 * available RPCs (see cre/lib/log-range.js), so it works everywhere and is
 * only worth raising to trade portability for fewer round trips.
 *
 * @param {unknown} value — `config.logChunkBlocks`, may be absent
 * @returns {bigint} the validated chunk width in blocks
 */
export function assertLogChunkBlocks(value) {
  if (value === undefined || value === null || value === '') return 10_000n;
  let blocks;
  try {
    blocks = BigInt(/** @type {string|number} */ (value));
  } catch {
    throw new Error(`aggregate config: logChunkBlocks must be a whole number of blocks, got ${JSON.stringify(value)}`);
  }
  if (blocks <= 0n) {
    throw new Error(`aggregate config: logChunkBlocks must be positive, got ${JSON.stringify(value)}`);
  }
  return blocks;
}
