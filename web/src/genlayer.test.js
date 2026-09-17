import { describe, expect, it } from 'vitest';
import { byRequest, createGenLayerReader, isBreach, toSettlement } from './genlayer.js';

const REQUEST_ID = `0x${'ab'.repeat(32)}`;

/** One entry of `list_claims`, in the shape the contract's view returns. */
const claim = (overrides = {}) => ({
  request_id: REQUEST_ID,
  clause_id: 'faithful',
  slug: 'summarizer',
  claimant: '0x1111111111111111111111111111111111111111',
  criteria: 'The summary must describe the document supplied.',
  disclosure_signature: `0x${'11'.repeat(65)}`,
  paid_amount: 2500,
  bond: 1000,
  resolved: true,
  outcome: 'BREACH',
  reasoning: 'It summarised a different document.',
  compensation: 2500,
  bounty: 100,
  ...overrides
});

describe('toSettlement', () => {
  it('reads a resolved claim', () => {
    expect(toSettlement(claim())).toEqual({
      requestId: REQUEST_ID,
      clauseId: 'faithful',
      slug: 'summarizer',
      claimant: '0x1111111111111111111111111111111111111111',
      criteria: 'The summary must describe the document supplied.',
      outcome: 'BREACH',
      resolved: true,
      reasoning: 'It summarised a different document.',
      paidAmount: 2500n,
      compensation: 2500n,
      bounty: 100n
    });
  });

  it('keeps the amounts as bigints, same as every other money value here', () => {
    const settlement = toSettlement(claim({ paid_amount: '9007199254740993' }));
    expect(settlement.paidAmount).toBe(9007199254740993n);
  });

  // A contract newer than this bundle is a fact to show, not a value to guess
  // at. Coercing it to a known outcome would quietly misreport a judgement.
  it('surfaces an outcome it does not recognise rather than coercing it', () => {
    expect(toSettlement(claim({ outcome: 'SOMETHING_NEW' })).outcome).toBe('UNKNOWN');
  });

  it('reads an open claim as unresolved', () => {
    const settlement = toSettlement(claim({ outcome: 'OPEN', resolved: false, compensation: 0, bounty: 0 }));
    expect(settlement).toMatchObject({ outcome: 'OPEN', resolved: false, compensation: 0n });
  });
});

describe('byRequest', () => {
  it('groups several clauses disputed on the same call', () => {
    const index = byRequest([
      toSettlement(claim({ clause_id: 'first' })),
      toSettlement(claim({ clause_id: 'second' }))
    ]);
    expect(index.get(REQUEST_ID.toLowerCase())).toHaveLength(2);
  });

  it('indexes case-insensitively, since a request id arrives in either case', () => {
    const index = byRequest([toSettlement(claim({ request_id: REQUEST_ID.toUpperCase().replace('0X', '0x') }))]);
    expect(index.get(REQUEST_ID.toLowerCase())).toHaveLength(1);
  });

  it('is empty for a request nothing disputed', () => {
    expect(byRequest([]).get(REQUEST_ID)).toBeUndefined();
  });
});

// Only BREACH is a finding against the provider. UNDETERMINED and CANCELLED
// decided nothing at all, and counting either against a provider would make
// missing evidence worth manufacturing.
describe('isBreach', () => {
  it.each([
    ['BREACH', true],
    ['MET', false],
    ['UNDETERMINED', false],
    ['CANCELLED', false],
    ['OPEN', false]
  ])('%s → %s', (outcome, expected) => {
    expect(isBreach(toSettlement(claim({ outcome })))).toBe(expected);
  });
});

describe('createGenLayerReader', () => {
  // Absent has to stay distinguishable from "deployed, nothing disputed": the
  // first means the dashboard can say nothing, the second means there is
  // nothing to say.
  it('is null with no judge address', () => {
    expect(createGenLayerReader({ network: 'testnet_bradbury' })).toBeNull();
    expect(createGenLayerReader({})).toBeNull();
  });

  it('is null for a network genlayer-js does not know', () => {
    expect(createGenLayerReader({ network: 'mainnet', judgeAddress: `0x${'ab'.repeat(20)}` })).toBeNull();
  });

  it('builds a reader for a configured judge', () => {
    const reader = createGenLayerReader({ network: 'testnet_bradbury', judgeAddress: `0x${'ab'.repeat(20)}` });
    expect(reader?.judgeAddress).toBe(`0x${'ab'.repeat(20)}`);
  });

  // studio_devnet is the Agent Tank submission target, not testnet_bradbury —
  // and it is not one of genlayer-js@1.x's four built-in chains, so it has to
  // resolve through the hand-built chain object rather than a lookup miss.
  it('defaults to studio_devnet when no network is given', () => {
    const reader = createGenLayerReader({ judgeAddress: `0x${'ab'.repeat(20)}` });
    expect(reader?.judgeAddress).toBe(`0x${'ab'.repeat(20)}`);
  });

  it('builds a reader for studio_devnet explicitly', () => {
    const reader = createGenLayerReader({ network: 'studio_devnet', judgeAddress: `0x${'ab'.repeat(20)}` });
    expect(reader?.judgeAddress).toBe(`0x${'ab'.repeat(20)}`);
  });
});
