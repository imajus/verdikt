import { describe, expect, it } from 'vitest';
import { createSource } from './source.js';

// The demo source is the only data most visitors ever see, and the landing page
// now publishes it as proof beside the rules it is supposed to illustrate. So
// it is held to those rules: seeded numbers that contradict the mechanism are
// worse than an empty marketplace, which is the thing the seed exists to avoid.

const NATIVE_PER_MINOR_UNIT = 10n ** 12n;
const DEPOSIT_AMOUNT = 10n * 10n ** 18n;

const demo = () => {
  const { mode, deps } = createSource({});
  expect(mode).toBe('demo');
  return deps;
};

describe('seeded demo data', () => {
  it('never refunds more than the call was paid', async () => {
    const deps = demo();
    const verdicts = await deps.registry.listVerdicts();
    const paidBy = new Map(verdicts.map((verdict) => [verdict.requestId, verdict.paidAmount]));
    for (const refund of await deps.registry.listRefunds()) {
      const paid = paidBy.get(refund.requestId);
      expect(paid, `refund ${refund.requestId} names no verdict`).toBeDefined();
      // The registry caps a credit at min(FIXED_REFUND, paidAmount, deposit),
      // and paidAmount is minor units against a bond in native wei.
      expect(refund.amount).toBeLessThanOrEqual(/** @type {bigint} */ (paid) * NATIVE_PER_MINOR_UNIT);
    }
  });

  it('credits every verdict that did not pass, DOWN included', async () => {
    const deps = demo();
    const refunded = new Set((await deps.registry.listRefunds()).map((refund) => refund.requestId));
    const uncredited = (await deps.registry.listVerdicts())
      .filter((verdict) => verdict.outcome !== 'PASS' && !refunded.has(verdict.requestId));
    expect(uncredited.map((verdict) => verdict.outcome)).toEqual([]);
  });

  it('leaves each bond at what its refunds actually took out of it', async () => {
    const deps = demo();
    const refunds = await deps.registry.listRefunds();
    for (const service of await deps.registry.listServices()) {
      const taken = refunds
        .filter((refund) => refund.serviceId === service.serviceId)
        .reduce((total, refund) => total + refund.amount, 0n);
      expect(service.deposit, `${service.slug}'s bond`).toBe(DEPOSIT_AMOUNT - taken);
      // A bond drained to nothing is what suspends a service — the one part of
      // this seed that exists to show a verdict having teeth.
      expect(service.status).toBe(service.deposit === 0n ? 'SUSPENDED' : 'ACTIVE');
    }
  });
});
