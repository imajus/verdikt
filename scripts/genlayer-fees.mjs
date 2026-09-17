// The fee and receipt details GenLayer's consensus v0.6 requires, in one place
// because two callers need them: `claim.mjs cancel` and
// `runner/bin/resolve-claims.mjs`. Both route through the judge's `_settle`,
// which emits an internal message to the settlement token.
//
// This logic cost a debugging cycle to get right and fails in
// unrelated-looking ways when it is wrong, so it lives here rather than in two
// copies that can drift apart.

import {
  deriveInternalMessageCallKey,
  encodeInternalMessageFeeParams,
  MessageType,
  MESSAGE_ALLOCATION_ROOT_PARENT_INDEX
} from 'genlayer-js';

/**
 * Fee budget for the settlement messages `_settle` emits. A round number with
 * slack in it, not a measurement: the usual way to size this —
 * `estimateTransactionFeesForWrite` — cannot be used here, because estimating
 * means simulating, and simulating `resolve_claim` runs the LLM judgment.
 * `sim_estimateTransactionFees` answers `execution failed` for exactly that
 * reason. Unspent budget is not consumed.
 */
export const MESSAGE_BUDGET = BigInt(process.env.GENLAYER_MESSAGE_BUDGET ?? 2n * 10n ** 17n);

/**
 * The allocation consensus v0.6 requires for the internal message `_settle`
 * sends to the settlement token.
 *
 * Without it the transaction runs, the validators agree on the judgment, and
 * the whole thing then fails with `fee no_matching_allocation # internal` —
 * the money leg rejected after the judging leg succeeded. So this is not
 * tuning, it is the difference between a claim that settles and one that
 * cannot.
 *
 * Two details that are easy to get wrong and fail in unrelated-looking ways:
 *
 * - `callKey` must *name the method being called* — `release`.
 *   `CALL_KEY_UNNAMED` is zeros and looks like a wildcard but is not one
 *   (`CALL_KEY_WILDCARD` is a different constant), and an unnamed key matches
 *   nothing, giving the same `no_matching_allocation`.
 * - One entry per key. `_settle` can emit several `release` messages — bond,
 *   compensation, bounty — and they all draw on this single allocation's
 *   budget. Listing it once per message is `AllocationDuplicateKey`.
 *
 * @param {Record<string, any>} distribution what `estimateFeesDistribution()` returned
 * @param {string} settlementToken the token `_settle` releases from
 */
export function settlementAllocations(distribution, settlementToken) {
  return [
    {
      messageType: MessageType.Internal,
      // `_settle` emits `on='finalized'`, never on acceptance.
      onAcceptance: false,
      parentIndex: MESSAGE_ALLOCATION_ROOT_PARENT_INDEX,
      recipient: settlementToken,
      callKey: deriveInternalMessageCallKey('release'),
      budget: MESSAGE_BUDGET,
      feeParams: encodeInternalMessageFeeParams({
        leaderTimeunitsAllocation: distribution.leaderTimeunitsAllocation,
        validatorTimeunitsAllocation: distribution.validatorTimeunitsAllocation,
        appealRounds: 0,
        executionBudgetPerRound: distribution.executionBudgetPerRound,
        rotations: [0],
        maxPriceGenPerTimeUnit: distribution.maxPriceGenPerTimeUnit,
        storageFeeMaxGasPrice: distribution.storageFeeMaxGasPrice,
        receiptFeeMaxGasPrice: distribution.receiptFeeMaxGasPrice
      })
    }
  ];
}

/**
 * What actually went wrong, out of a leader receipt.
 *
 * `genvm_result.stderr` is empty for a consensus-level rejection, so reading
 * only that turns every such failure into `ERROR` and hides the cause. The
 * real payload is base64 in `result` — that is where
 * `fee no_matching_allocation # internal` hid while a scheduled job reported
 * nothing useful twice in a row.
 *
 * @param {Record<string, any>|undefined} leader `consensus_data.leader_receipt[0]`
 * @returns {string}
 */
export function describeFailure(leader) {
  const stderr = String(leader?.genvm_result?.stderr ?? '').trim();
  if (stderr) return stderr.slice(0, 300);
  const result = leader?.result;
  if (typeof result === 'string') {
    try {
      return Buffer.from(result, 'base64').toString('utf8').slice(0, 300);
    } catch {
      // Fall through to whatever structured form is there.
    }
  }
  if (result && typeof result === 'object') {
    return String(result.payload ?? result.status ?? JSON.stringify(result)).slice(0, 300);
  }
  return leader?.execution_result ?? 'no execution_result on the leader receipt';
}
