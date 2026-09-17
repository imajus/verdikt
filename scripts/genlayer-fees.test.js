import { describe, expect, it } from 'vitest';
import { MESSAGE_BUDGET, describeFailure, settlementAllocations } from './genlayer-fees.mjs';

const TOKEN = `0x${'ab'.repeat(20)}`;

/** What `estimateFeesDistribution()` returns, in the shape the chain reports. */
const distribution = () => ({
  leaderTimeunitsAllocation: 100n,
  validatorTimeunitsAllocation: 200n,
  appealRounds: 0n,
  executionBudgetPerRound: 25000000000000000n,
  executionConsumed: 0n,
  totalMessageFees: 0n,
  rotations: [3n],
  maxPriceGenPerTimeUnit: 2n,
  storageFeeMaxGasPrice: 300000000n,
  receiptFeeMaxGasPrice: 300000000n
});

describe('settlementAllocations', () => {
  // One entry per call key. `_settle` can emit several `release` messages —
  // bond, compensation, bounty — and they all draw on this one allocation's
  // budget. Listing it per message is AllocationDuplicateKey.
  it('is exactly one allocation', () => {
    expect(settlementAllocations(distribution(), TOKEN)).toHaveLength(1);
  });

  // The key has to name the method. CALL_KEY_UNNAMED is zeros, reads like a
  // wildcard, and matches nothing — giving the same no_matching_allocation
  // the allocation exists to prevent.
  it('names the release method in the call key', () => {
    const [allocation] = settlementAllocations(distribution(), TOKEN);
    expect(allocation.callKey).toMatch(/^0x72656c65617365/);
  });

  it('points at the settlement token it was given', () => {
    const [allocation] = settlementAllocations(distribution(), TOKEN);
    expect(allocation.recipient).toBe(TOKEN);
  });

  // `_settle` emits on='finalized', never on acceptance.
  it('allocates for a finalized message', () => {
    const [allocation] = settlementAllocations(distribution(), TOKEN);
    expect(allocation.onAcceptance).toBe(false);
    expect(allocation.budget).toBe(MESSAGE_BUDGET);
  });
});

describe('describeFailure', () => {
  it('prefers stderr when the VM wrote one', () => {
    expect(describeFailure({ genvm_result: { stderr: 'NameError: gl' } })).toBe('NameError: gl');
  });

  // The case that matters: a consensus-level rejection writes no stderr at
  // all, and reading only stderr reports every one of them as `ERROR`.
  it('decodes the base64 result when stderr is empty', () => {
    const payload = Buffer.from('fee no_matching_allocation # internal').toString('base64');
    expect(describeFailure({ genvm_result: { stderr: '' }, result: payload })).toContain('no_matching_allocation');
  });

  it('reads a structured result object', () => {
    const leader = { result: { status: 'contract_error', payload: 'fee no_matching_allocation # internal' } };
    expect(describeFailure(leader)).toBe('fee no_matching_allocation # internal');
  });

  it('says something rather than nothing when there is no detail at all', () => {
    expect(describeFailure({ execution_result: 'ERROR' })).toBe('ERROR');
    expect(describeFailure(undefined)).toContain('no execution_result');
  });
});
