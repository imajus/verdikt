// Assembling what the marketplace shows, from Arc events and ENS records.
//
// Both chains are read through @verdikt/sdk, so this file knows neither an ABI
// nor a resolver address (Specification.md §3, §5). It is pure data shaping over
// injected readers, which is what makes it testable without either chain.

import { aggregateWindow, parseSla } from '@verdikt/sla';
import { WINDOW_SECONDS } from '@verdikt/cre/reputation';
import { matchFailedClause } from '@verdikt/sdk/registry';

/**
 * Everything the listing and the detail views need, in one pass.
 *
 * The window for `unpublished` is whatever block range the reader was given —
 * `VerdictWritten` carries no timestamp, so a per-log time would have to be
 * invented (docs/spikes/cre.md, CRE-7). Bound it with the reader's `fromBlock`
 * rather than filtering here on a number the chain never gave us.
 *
 * @param {MarketplaceDeps} deps
 * @returns {Promise<Marketplace>}
 */
export async function loadMarketplace({ registry, resolve }) {
  const [services, verdicts, refunds] = await Promise.all([
    registry.listServices(),
    registry.listVerdicts(),
    registry.listRefunds()
  ]);

  // A service whose subname is unreachable is still a listing — it has a bond
  // and a verdict history on Arc. Dropping it because Sepolia was down would
  // make an ENS outage look like services disappearing.
  const records = await Promise.all(
    services.map((service) => resolve(service.slug).catch(() => null))
  );

  const refundsByRequest = new Map(refunds.map((refund) => [refund.requestId, refund]));

  /** @type {Listing[]} */
  const listings = services.map((service, index) => {
    const record = records[index];
    const own = verdicts.filter((verdict) => verdict.serviceId === service.serviceId);
    // Hoisted because the history resolves each verdict's clause hash against
    // it. The chain stores `keccak256(clauseId)`, so the SLA is the only key.
    const sla = parseSlaOrNull(record?.sla ?? null);
    const history = own
      .map((verdict) => ({
        ...verdict,
        refunded: refundsByRequest.get(verdict.requestId)?.amount ?? 0n,
        failedClauseId: matchFailedClause(verdict.failedClause, sla)
      }))
      .reverse();

    return {
      serviceId: service.serviceId,
      slug: service.slug,
      name: record?.name ?? `${service.slug}.verdikt.eth`,
      provider: service.provider,
      status: service.status,
      deposit: service.deposit,
      endpoint: record?.url ?? null,
      payTo: record?.address ?? null,
      namingLayer: /** @type {'ok'|'unreachable'} */ (record === null ? 'unreachable' : 'ok'),
      sla,
      slaRaw: record?.sla ?? null,
      /** As published on ENS — the number a consumer actually ranks on. */
      published: { conformance: record?.conformance ?? null, availability: record?.availability ?? null },
      /**
       * The same computation the hourly workflow runs, over the same events.
       * Shown only where nothing is published yet, and labelled as such: it is
       * the shared `aggregateWindow`, not a second implementation, but it is
       * still not what the marketplace ranks on.
       */
      unpublished: aggregateWindow(own),
      history
    };
  });

  return { services: listings, stats: platformStats(listings, verdicts, refunds) };
}

/** @param {string|null} raw */
function parseSlaOrNull(raw) {
  if (!raw) return null;
  try {
    return parseSla(raw);
  } catch {
    // A published SLA that will not parse is exactly what the status-only
    // fallback exists for, and a consumer should be able to see that state
    // rather than an empty panel.
    return null;
  }
}

/**
 * @param {Listing[]} listings
 * @param {VerdictRecord[]} verdicts
 * @param {RefundRecord[]} refunds
 * @returns {PlatformStats}
 */
function platformStats(listings, verdicts, refunds) {
  const breakdown = { PASS: 0, FAIL: 0, DOWN: 0 };
  for (const verdict of verdicts) breakdown[verdict.outcome] += 1;

  return {
    services: listings.length,
    active: listings.filter((listing) => listing.status === 'ACTIVE').length,
    suspended: listings.filter((listing) => listing.status === 'SUSPENDED').length,
    bonded: listings.reduce((total, listing) => total + listing.deposit, 0n),
    verdicts: verdicts.length,
    breakdown,
    refundCount: refunds.length,
    refunded: refunds.reduce((total, refund) => total + refund.amount, 0n),
    windowSeconds: WINDOW_SECONDS
  };
}

/**
 * Rank for the listing: the **product** of the two published ratios.
 *
 * Not one before the other. Ordering by availability first put a service that
 * answered every call and broke its SLA on every one of them above a service
 * that delivered correctly and blipped once — which is the marketplace
 * recommending the worse option. The product means neither ratio can carry a
 * listing on its own: a service has to both answer and deliver.
 *
 * Services with nothing published sort last rather than first — an unranked
 * listing must not outrank one with a real record.
 *
 * @param {Listing} a
 * @param {Listing} b
 */
export const byReputation = (a, b) => {
  /** @param {Listing} listing */
  const rank = (listing) =>
    listing.published.availability === null || listing.published.conformance === null
      ? -1
      : listing.published.availability * listing.published.conformance;
  const difference = rank(b) - rank(a);
  if (difference !== 0) return difference;
  if (a.deposit !== b.deposit) return a.deposit > b.deposit ? -1 : 1;
  return a.slug.localeCompare(b.slug, 'en');
};
