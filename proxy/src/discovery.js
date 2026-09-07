// The machine-facing discovery API (Specification.md §5, stretch 2).
//
// The human dashboard answers "which of these should I use". This answers the
// same question for an agent that will never look at a page: the marketplace,
// as JSON, filterable on the things an agent actually chooses on — what a call
// costs, how slow it is allowed to be, and how the service has actually
// behaved.
//
// It lives on the proxy rather than in `web/` because an agent that is about to
// call `<slug>.verdikt.bond` already has the proxy's address, and because the
// dashboard is a static bundle with no server to answer from.
//
// Read-only, unauthenticated, and derived entirely from public data: Arc
// events, and the provider's own published records.

/**
 * The bound a service publishes for each thing an agent filters on, pulled out
 * of its SLA. `null` where the service declares nothing — which is itself
 * information, and must not be confused with zero.
 *
 * @param {SlaDocument|null} sla
 */
function advertised(sla) {
  const clauses = sla?.clauses ?? [];
  const latency = clauses.find((clause) => clause.type === 'latency');
  const price = clauses.find((clause) => clause.type === 'priceRange');
  return {
    maxLatencyMs: latency ? latency.maxMs : null,
    /** Decimal strings in the asset's minor units — never a float. */
    minPriceMinorUnits: price ? price.minMinorUnits : null,
    maxPriceMinorUnits: price ? price.maxMinorUnits : null,
    asset: price ? price.asset : null,
    clauses: clauses.map((clause) => ({ id: clause.id, type: clause.type }))
  };
}

/**
 * One listing, as an agent sees it.
 *
 * `conformance` and `availability` are what the service has *published* — the
 * hourly aggregate's numbers. The locally-derived figures the dashboard shows
 * while a listing is unranked are deliberately absent: an agent choosing
 * between services must compare like with like, and a number this proxy
 * computed is not the number the marketplace ranks on.
 *
 * @param {Listing} listing
 * @param {string} publicHost
 */
export function toListing(listing, publicHost) {
  return {
    slug: listing.slug,
    name: listing.name,
    serviceId: listing.serviceId,
    endpoint: `https://${listing.slug}.${publicHost}`,
    status: listing.status,
    provider: listing.provider,
    payTo: listing.payTo,
    reputation: {
      conformance: listing.published.conformance,
      availability: listing.published.availability,
      /** How many paid calls those ratios rest on. A 1000 from one call is not a 1000 from a thousand. */
      verdicts: listing.history.length,
      published: listing.published.conformance !== null
    },
    /** Native 18-decimal view, as a decimal string: JSON has no bigint. */
    bond: listing.deposit.toString(),
    sla: advertised(listing.sla)
  };
}

/**
 * @param {ReturnType<typeof toListing>} entry
 * @param {Record<string, string|undefined>} query
 */
function matches(entry, query) {
  const { minConformance, minAvailability, maxLatencyMs, maxPriceMinorUnits, status } = query;

  // An unpublished score fails a minimum rather than passing it. The dashboard
  // presumes a quiet service healthy because a human can see the caveat next to
  // it; an agent filtering on `minConformance=990` is asking for evidence, and
  // "no evidence yet" is not evidence.
  if (minConformance !== undefined) {
    if (entry.reputation.conformance === null || entry.reputation.conformance < Number(minConformance)) return false;
  }
  if (minAvailability !== undefined) {
    if (entry.reputation.availability === null || entry.reputation.availability < Number(minAvailability)) return false;
  }
  // A service that promises nothing about latency does not satisfy a latency
  // bound, for the same reason.
  if (maxLatencyMs !== undefined) {
    if (entry.sla.maxLatencyMs === null || entry.sla.maxLatencyMs > Number(maxLatencyMs)) return false;
  }
  if (maxPriceMinorUnits !== undefined) {
    if (entry.sla.maxPriceMinorUnits === null) return false;
    // Integer comparison, in minor units, exactly as the price clause does it.
    if (BigInt(entry.sla.maxPriceMinorUnits) > BigInt(maxPriceMinorUnits)) return false;
  }
  if (status !== undefined && entry.status !== status.toUpperCase()) return false;
  return true;
}

/**
 * @param {Listing[]} listings
 * @param {Record<string, string|undefined>} query
 * @param {string} publicHost
 */
export function discover(listings, query, publicHost) {
  const entries = listings.map((listing) => toListing(listing, publicHost)).filter((entry) => matches(entry, query));
  return {
    count: entries.length,
    // Stated rather than implied: an agent reading `conformance: null` should
    // know why, and one filtering on it should know what was excluded.
    note:
      'conformance and availability are the trailing-7-day ratios published on ' +
      '<slug>.verdikt.eth, 0-1000, recomputed hourly. null means the hourly run ' +
      'has not written this listing yet; a filter treats that as not matching. ' +
      'Prices are integer minor units of the named asset.',
    services: entries
  };
}
