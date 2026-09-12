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

    const contested =
      record !== null && record.owner !== null && record.owner.toLowerCase() !== service.provider.toLowerCase();
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
      contested,
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

/**
 * Whether a listing belongs on the marketplace at all.
 *
 * `deregister` delists (Specification.md §3): the bond is returned, the proxy
 * answers `service_not_active` to any call, and the slug can never be
 * registered again. Keeping such a row on the marketplace advertises a route
 * that cannot be taken — and since deregistering on Arc leaves the ENS records
 * standing, its published scores would still rank it under `byReputation`.
 *
 * The listing is filtered, not the data: `loadMarketplace` still returns every
 * service, because a retired one keeps a verdict history on Arc and its own
 * page has to stay reachable by slug.
 *
 * @param {Listing} listing
 */
export const isListed = (listing) => listing.status !== 'DEREGISTERED';

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
    // The same set the marketplace lists, so "N services · X active" adds up.
    // Verdicts and refunds are not filtered: they happened, and a retired
    // service's history stays part of the platform's record.
    services: listings.filter(isListed).length,
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

/**
 * A decimal USDC string ("0.0025") to minor units, or `null` when it does not
 * parse. Mirrors `usdcToMinorUnits` in `forms/sla-draft.js` rather than
 * importing that UI-layer file into this one — this module has to stay
 * something `loadMarketplace`'s own tests can drive without pulling in the
 * composer.
 * @param {string} text
 */
function usdcTextToMinorUnits(text) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/**
 * Whether `listing` matches the marketplace's search box and filter controls
 * (issue #64). Pure and synchronous: the whole list is already in memory, so
 * every keystroke just re-filters it — no new RPC call.
 *
 * A cap named against a bound the listing has not declared — no `priceRange`
 * clause, no `latency` clause — passes rather than being excluded: the filter
 * is a claim about a declared bound, and a service that made no claim has not
 * failed to meet it. The same reasoning applies to `minConformance` and
 * `minAvailability` against a listing with nothing published yet (`null`):
 * excluding it would punish "not yet ranked" as if it had measured badly.
 *
 * @param {Listing} listing
 * @param {MarketplaceFilters} filters
 */
export function matchesFilters(listing, filters) {
  const query = filters.query.trim().toLowerCase();
  if (query && !listing.slug.toLowerCase().includes(query) && !listing.name.toLowerCase().includes(query)) return false;
  if (listing.published.conformance !== null && listing.published.conformance < filters.minConformance) return false;
  if (listing.published.availability !== null && listing.published.availability < filters.minAvailability) return false;
  if (filters.maxPriceUsdc) {
    const cap = usdcTextToMinorUnits(filters.maxPriceUsdc);
    const clause = /** @type {SlaPriceRangeClause|undefined} */ (listing.sla?.clauses.find((c) => c.type === 'priceRange'));
    if (cap !== null && clause && BigInt(clause.minMinorUnits) > cap) return false;
  }
  if (filters.maxLatencyMs) {
    const cap = Number(filters.maxLatencyMs);
    const clause = /** @type {SlaLatencyClause|undefined} */ (listing.sla?.clauses.find((c) => c.type === 'latency'));
    if (Number.isFinite(cap) && clause && clause.maxMs > cap) return false;
  }
  return true;
}

/** @param {number|null} a @param {number|null} b */
const rankNullLast = (a, b) => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
};

/** @param {Listing} a @param {Listing} b */
const byConformance = (a, b) => rankNullLast(a.published.conformance, b.published.conformance);
/** @param {Listing} a @param {Listing} b */
const byAvailability = (a, b) => rankNullLast(a.published.availability, b.published.availability);
/** @param {Listing} a @param {Listing} b */
const byDeposit = (a, b) => (a.deposit === b.deposit ? 0 : a.deposit > b.deposit ? -1 : 1);

/** @type {Record<MarketplaceSortKey, (a: Listing, b: Listing) => number>} */
const SORTERS = { reputation: byReputation, conformance: byConformance, availability: byAvailability, deposit: byDeposit };

/**
 * `listings`, ranked by `sort`. Every comparator above ranks best-first; a
 * `direction` of `desc` (the default a clicked column starts at) keeps that
 * order, `asc` reverses it.
 *
 * @param {Listing[]} listings
 * @param {MarketplaceSort} sort
 */
export function sortListings(listings, sort) {
  const ranked = [...listings].sort(SORTERS[sort.key]);
  return sort.direction === 'asc' ? ranked.reverse() : ranked;
}

/** @type {MarketplaceSort} */
export const DEFAULT_MARKETPLACE_SORT = { key: 'reputation', direction: 'desc' };

/** @type {MarketplaceFilters} */
export const DEFAULT_MARKETPLACE_FILTERS = {
  query: '',
  minConformance: 0,
  minAvailability: 0,
  maxPriceUsdc: '',
  maxLatencyMs: ''
};
