// Splitting a log scan into ranges an RPC will actually answer
// (Specification.md §1; Tasks.md 3.2).
//
// WHY THIS EXISTS
//
// The aggregate workflow asked for `ServiceRegistered` from the registry's
// deployment block to head in one `filterLogs` call, and `VerdictWritten` over
// the whole trailing window in another. Both worked on the day the registry
// was deployed and both are doomed by Arc's sub-second blocks: the
// deploy-to-head range only grows, and the window range saturates at
// WINDOW_SECONDS / blockTimeSeconds blocks: 163,451 at the one-day window
// currently in force, 1,144,155 at the 7 days the spec asks for — see the
// TEMPORARY (demo window) note on WINDOW_SECONDS in reputation.js. Every
// `eth_getLogs` provider caps that range, so the run does not degrade — it
// fails outright, and it fails *later*, long after the change that "worked".
//
// Measured caps, not guessed: `rpc.testnet.arc.network` accepts 30,000 blocks
// and answers `requested range too large` above it; Arc via Alchemy accepts
// 10,000. The shipped width is 10,000 — not because it is the safer of two
// otherwise equal options, but because `project.yaml` pins Alchemy, and it
// pins Alchemy because the wider endpoint rate-limits after three sequential
// requests. Range and throughput are separate limits and this workload is
// bounded by the second one; see project.yaml for the measurement.
//
// Pure, and here rather than in `workflow.ts`, for the reason the rest of
// `cre/lib` is here: `cre workflow simulate` cannot run unattended (Spike B,
// CRE-1), so arithmetic that lives in the workflow is arithmetic nothing tests
// on every commit. This is exactly the kind that is easy to get wrong by one
// block at either end — and an off-by-one here silently drops or double-counts
// a verdict at a chunk boundary.

/**
 * Inclusive `[from, to]` ranges covering `fromBlock..toBlock`, none wider than
 * `maxRange` blocks.
 *
 * Both ends are inclusive, matching `eth_getLogs`, so a chunk of `maxRange`
 * blocks spans `from + maxRange - 1n`. The ranges are contiguous and
 * ascending: consecutive chunks never overlap (which would double-count a
 * verdict) and never skip a block (which would lose one).
 *
 * An empty result when `toBlock < fromBlock` is deliberate and not an error —
 * it is what a head that has not advanced past the deploy block looks like.
 *
 * @param {bigint} fromBlock first block to scan, inclusive
 * @param {bigint} toBlock last block to scan, inclusive
 * @param {bigint} maxRange maximum blocks per chunk; must be positive
 * @returns {{ from: bigint, to: bigint }[]}
 */
export function blockRangeChunks(fromBlock, toBlock, maxRange) {
  if (maxRange <= 0n) {
    throw new Error(`blockRangeChunks: maxRange must be positive, got ${maxRange}`);
  }
  /** @type {{ from: bigint, to: bigint }[]} */
  const chunks = [];
  for (let from = fromBlock; from <= toBlock; from += maxRange) {
    const end = from + maxRange - 1n;
    chunks.push({ from, to: end > toBlock ? toBlock : end });
  }
  return chunks;
}
