// Startup validation for the aggregate workflow's config (Specification.md §1;
// Tasks.md 3.2).
//
// The workflow's `Config` is a TypeScript type. It is erased at compile time,
// so nothing checks `config.staging.json` against it at runtime — the same
// reason `judge.js` and `reputation.js` live here under vitest rather than in
// the untested `.ts` plumbing (Spike B, CRE-1).
//
// One field is load-bearing and fails in the worst way when wrong.
// `blockTimeSeconds` divides the 7-day window into a `fromBlock` and dates
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
