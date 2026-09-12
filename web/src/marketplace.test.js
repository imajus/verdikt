import { afterEach, describe, expect, it, vi } from 'vitest';
import { SLA_TEXT } from '@verdikt/fixtures';
import { ARC } from '@verdikt/sdk';
import { DELIVERY_CLAUSE, NO_CLAUSE, clauseHash } from '@verdikt/sdk/registry';
import { formatMinorRange, formatMinorUsdc, formatNativeUsdc, formatRefundUsdc, formatScore, formatTxError, scoreBand, shortHex } from './format.js';
import { byReputation, loadMarketplace } from './marketplace.js';
import { renderApp, renderDetail } from './render.js';

// The rendered page asks who is connected and whether they are signed in.
// Both answer "nobody" unless a test says otherwise, which is the visitor's
// view every other test here renders.
const wallet = vi.hoisted(() => ({ account: /** @type {any} */ (null), session: /** @type {any} */ (null) }));
vi.mock('./wallet.js', () => ({ getConnectedAccount: () => wallet.account }));
vi.mock('./session.js', () => ({ getSession: () => wallet.session }));

const HONEST = `0x${'11'.repeat(32)}`;
const FLAKY = `0x${'22'.repeat(32)}`;
const PROVIDER = '0xA11ce00000000000000000000000000000000001';

/** @param {Partial<ServiceRecord>} overrides @returns {ServiceRecord} */
const record = (overrides) => ({
  slug: 'weather',
  name: 'weather.verdikt.eth',
  serviceId: HONEST,
  address: '0x2222222222222222222222222222222222222222',
  url: 'https://provider.example/weather',
  sla: SLA_TEXT.honest,
  conformance: 1000,
  availability: 1000,
  owner: null,
  backend: 'fixture',
  resolvedAt: 0,
  ...overrides
});

/**
 * @param {object} [options]
 * @param {RegisteredService[]} [options.services]
 * @param {VerdictRecord[]} [options.verdicts]
 * @param {RefundRecord[]} [options.refunds]
 * @param {Record<string, ServiceRecord|Error>} [options.records]
 */
const deps = ({ services = [], verdicts = [], refunds = [], records = {} } = {}) => ({
  registry: {
    listServices: async () => services,
    listVerdicts: async () => verdicts,
    listRefunds: async () => refunds
  },
  resolve: async (/** @type {string} */ slug) => {
    const found = records[slug];
    if (found instanceof Error) throw found;
    if (!found) throw new Error(`no record for ${slug}`);
    return found;
  }
});

/**
 * @param {string} slug
 * @param {string} serviceId
 * @param {Partial<RegisteredService>} [overrides]
 * @returns {RegisteredService}
 */
const service = (slug, serviceId, overrides = {}) => ({
  serviceId,
  slug,
  provider: '0xA11ce00000000000000000000000000000000001',
  status: 'ACTIVE',
  deposit: 10n * 10n ** 18n,
  registeredAtBlock: 1n,
  ...overrides
});

/**
 * @param {string} serviceId
 * @param {SlaOutcome} outcome
 * @param {string} requestId
 * @param {string} [failedClause]
 * @returns {VerdictRecord}
 */
const verdict = (serviceId, outcome, requestId, failedClause = NO_CLAUSE) => ({
  serviceId,
  requestId,
  outcome,
  payer: '0x1111111111111111111111111111111111111111',
  paidAmount: 2500n,
  failedClause,
  blockNumber: 10n,
  transactionHash: `0x${'ab'.repeat(32)}`
});

// viem throws with the human sentence on `shortMessage` and a full diagnostic
// body on `message` — calldata, a docs URL, its own version. The body puts an
// unbroken hex blob through the layout and buries the one fact a provider can
// act on.
describe('formatting a wallet error', () => {
  const rejection = Object.assign(
    new Error([
      'User rejected the request.',
      '',
      'Request Arguments:',
      '  from:  0x9cbb40d45ec9dd095309bba505f3bc54e63a3a79',
      '  data:  0xf2c298be0000000000000000000000000000000000000000000000000000000000000020',
      '',
      'Docs: https://viem.sh/docs/contract/writeContract',
      'Version: viem@2.56.3'
    ].join('\n')),
    { shortMessage: 'User rejected the request.' }
  );

  it('keeps the short sentence and drops the diagnostic body', () => {
    expect(formatTxError(rejection)).toBe('User rejected the request.');
  });
  it('never carries calldata, a docs link or a version through to the page', () => {
    const shown = formatTxError(rejection);
    expect(shown).not.toContain('0xf2c298be');
    expect(shown).not.toContain('viem.sh');
    expect(shown).not.toContain('Version:');
  });
  it('falls back to the first line when an error carries no short form', () => {
    expect(formatTxError(new Error('Transport failed.\nstack line\nanother'))).toBe('Transport failed.');
  });
  it('caps a single long line rather than letting it run', () => {
    const shown = formatTxError(new Error('x'.repeat(400)));
    expect(shown.length).toBeLessThanOrEqual(160);
    expect(shown.endsWith('…')).toBe(true);
  });
  it('says something honest when the throw carries no message at all', () => {
    expect(formatTxError(null)).toBe('The request failed without a message.');
    expect(formatTxError({})).toBe('The request failed without a message.');
  });
});

describe('formatting the two USDC views', () => {
  // The bond moves as msg.value (18 decimals); what an agent paid comes off the
  // x402 leg (6). Rendering one with the other's scale is a millionfold error
  // in a number a consumer picks a service on.
  it('renders a bond in the native 18-decimal view', () => {
    expect(formatNativeUsdc(10n * 10n ** 18n, 2)).toBe('10 USDC');
    expect(formatNativeUsdc(10n ** 18n / 2n, 2)).toBe('0.5 USDC');
  });

  it('renders a payment in the 6-decimal minor-unit view', () => {
    expect(formatMinorUsdc(2500n)).toBe('0.0025 USDC');
    expect(formatMinorUsdc(1_000_000n)).toBe('1 USDC');
  });

  it('truncates rather than rounding, so a bond is never overstated', () => {
    expect(formatNativeUsdc(1_999_999_999_999_999_999n, 2)).toBe('1.99 USDC');
  });

  // A refund is capped at what was paid on the x402 leg, so a real credit can
  // be one USDC minor unit — 1e12 in the native view. The default four places
  // rendered that as "0 USDC", which is the ledger reporting no refund on a
  // row where the chain credited one.
  it('never renders a credited refund as zero', () => {
    expect(formatNativeUsdc(10n ** 12n)).toBe('0 USDC');
    expect(formatRefundUsdc(10n ** 12n)).toBe('0.000001 USDC');
    expect(formatRefundUsdc(10n ** 18n + 7n * 10n ** 12n)).toBe('1.000007 USDC');
  });

  it('reports a refund below its own resolution as a bound, not as nothing', () => {
    expect(formatRefundUsdc(1n)).toBe('< 0.000001 USDC');
    expect(formatRefundUsdc(0n)).toBe('0 USDC');
  });

  it('names the asset once across a range, so two bounds read as one band', () => {
    expect(formatMinorRange(1000n, 10_000n)).toBe('0.001 to 0.01 USDC');
  });

  it('shows an unpublished score as a dash, not as zero', () => {
    // Zero would brand a new listing as broken, the same mistake the
    // empty-window rule exists to prevent.
    expect(formatScore(null)).toBe('—');
    expect(scoreBand(null)).toBe('unknown');
    expect(formatScore(0)).toBe('0.0%');
    expect(scoreBand(0)).toBe('poor');
  });

  it('bands scores for colouring', () => {
    expect(scoreBand(1000)).toBe('good');
    expect(scoreBand(960)).toBe('fair');
    expect(scoreBand(500)).toBe('poor');
  });

  it('shortens hashes without losing either end', () => {
    expect(shortHex(`0x${'ab'.repeat(32)}`)).toBe('0xababab…ababab');
  });
});

describe('loadMarketplace', () => {
  it('joins Arc state to the ENS records', async () => {
    const { services } = await loadMarketplace(
      deps({
        services: [service('weather', HONEST)],
        verdicts: [verdict(HONEST, 'PASS', '0x01'), verdict(HONEST, 'FAIL', '0x02')],
        records: { weather: record({}) }
      })
    );
    expect(services[0]).toMatchObject({
      slug: 'weather',
      status: 'ACTIVE',
      endpoint: 'https://provider.example/weather',
      published: { conformance: 1000, availability: 1000 }
    });
    expect(services[0].sla?.clauses.length).toBeGreaterThan(0);
  });

  it('attaches the refund a failing call actually paid out', async () => {
    const { services } = await loadMarketplace(
      deps({
        services: [service('weather', HONEST)],
        verdicts: [verdict(HONEST, 'FAIL', '0x02')],
        refunds: [
          {
            serviceId: HONEST,
            requestId: '0x02',
            payer: '0x1111111111111111111111111111111111111111',
            amount: 10n ** 18n,
            blockNumber: 10n
          }
        ],
        records: { weather: record({}) }
      })
    );
    expect(services[0].history[0].refunded).toBe(10n ** 18n);
  });

  it('keeps a listing whose subname would not resolve', async () => {
    // It still has a bond and a verdict history on Arc. Dropping it would make
    // a Sepolia outage look like services disappearing.
    const { services } = await loadMarketplace(
      deps({ services: [service('weather', HONEST)], records: { weather: new Error('sepolia down') } })
    );
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ namingLayer: 'unreachable', published: { conformance: null } });
  });

  it('reports an unparseable SLA as no clauses rather than throwing', async () => {
    const { services } = await loadMarketplace(
      deps({ services: [service('weather', HONEST)], records: { weather: record({ sla: '{not json' }) } })
    );
    expect(services[0].sla).toBeNull();
    expect(services[0].slaRaw).toBe('{not json');
  });

  it('separates published scores from the same computation run locally', async () => {
    const { services } = await loadMarketplace(
      deps({
        services: [service('weather', HONEST)],
        verdicts: [verdict(HONEST, 'PASS', '0x01'), verdict(HONEST, 'FAIL', '0x02')],
        records: { weather: record({ conformance: null, availability: null }) }
      })
    );
    // Published is what the marketplace ranks on; the local number is the same
    // shared aggregateWindow, shown only to fill the gap before the first run.
    expect(services[0].published.conformance).toBeNull();
    expect(services[0].unpublished.conformance).toBe(500);
  });

  it('flags a listing as contested when the ENS owner and Arc provider disagree', async () => {
    const services = [service('weather', HONEST, { provider: '0xaaaa000000000000000000000000000000aaaa' })];
    const records = { weather: record({ owner: '0xbbbb000000000000000000000000000000bbbb' }) };
    const { services: listings } = await loadMarketplace(deps({ services, records }));
    expect(listings[0].contested).toBe(true);
  });

  it('does not flag a listing whose subname is simply unclaimed', async () => {
    const services = [service('weather', HONEST, { provider: '0xaaaa000000000000000000000000000000aaaa' })];
    const records = { weather: record({ owner: null }) };
    const { services: listings } = await loadMarketplace(deps({ services, records }));
    expect(listings[0].contested).toBe(false);
  });

  it('tallies platform stats across every service', async () => {
    const { stats } = await loadMarketplace(
      deps({
        services: [service('weather', HONEST), service('lite', FLAKY, { status: 'SUSPENDED', deposit: 0n })],
        verdicts: [verdict(HONEST, 'PASS', '0x01'), verdict(FLAKY, 'FAIL', '0x02'), verdict(FLAKY, 'DOWN', '0x03')],
        refunds: [
          { serviceId: FLAKY, requestId: '0x02', payer: '0x11', amount: 10n ** 18n, blockNumber: 1n }
        ],
        records: { weather: record({}), lite: record({ slug: 'lite', serviceId: FLAKY }) }
      })
    );
    expect(stats).toMatchObject({
      services: 2,
      active: 1,
      suspended: 1,
      bonded: 10n * 10n ** 18n,
      verdicts: 3,
      breakdown: { PASS: 1, FAIL: 1, DOWN: 1 },
      refunded: 10n ** 18n
    });
  });
});

// `deregister` delists (Specification.md §3) and the proxy answers
// `service_not_active` 503 to any call for one. A retired service that stays
// on the marketplace is the marketplace advertising a route that cannot be
// taken — and, because deregistering on Arc leaves the ENS records standing,
// a clean retired record sorts above live services under byReputation.
describe('a retired service', () => {
  const retired = () =>
    deps({
      services: [
        service('weather', HONEST, { status: 'DEREGISTERED', deposit: 0n }),
        service('lite', FLAKY)
      ],
      verdicts: [verdict(HONEST, 'PASS', '0x01')],
      records: {
        weather: record({}),
        lite: record({ slug: 'lite', name: 'lite.verdikt.eth', serviceId: FLAKY })
      }
    });

  it('is left off the public marketplace listing', async () => {
    const html = renderApp(await loadMarketplace(retired()), 'demo', 'marketplace', null);
    expect(html).not.toContain('weather.verdikt.eth');
    expect(html).toContain('lite.verdikt.eth');
  });

  it('is not counted among the platform’s services', async () => {
    const { stats } = await loadMarketplace(retired());
    expect(stats).toMatchObject({ services: 1, active: 1, suspended: 0 });
  });

  // Verdict history is keyed by serviceId and stays on Arc forever, so an
  // existing link to a retired service's page must still resolve rather than
  // 404 the record it is citing.
  it('still has its own page, so a link to its verdict history keeps working', async () => {
    const html = renderApp(await loadMarketplace(retired()), 'demo', 'service', 'weather');
    expect(html).toContain('What it delivered');
  });

  it('says on that page that it has been retired', async () => {
    const { services } = await loadMarketplace(retired());
    const listing = /** @type {Listing} */ (services.find((entry) => entry.slug === 'weather'));
    expect(renderDetail(listing)).toContain('retired');
  });
});

describe('byReputation', () => {
  /** @param {Partial<Listing>} overrides @returns {Listing} */
  const listing = (overrides) =>
    /** @type {Listing} */ ({
      slug: 'a',
      deposit: 0n,
      published: { conformance: 1000, availability: 1000 },
      ...overrides
    });

  it('ranks a service with a real record above one with none', () => {
    const ranked = [
      listing({ slug: 'unranked', published: { conformance: null, availability: null } }),
      listing({ slug: 'proven' })
    ].sort(byReputation);
    expect(ranked.map((entry) => entry.slug)).toEqual(['proven', 'unranked']);
  });

  // The bug this pins: ordering by availability first put a service that
  // answered every call and broke its SLA on every one of them above a service
  // that delivered correctly and blipped once — the marketplace recommending
  // the worse option. Ranking on the product means neither ratio carries a
  // listing alone.
  it('ranks a service that always answers but never conforms below one that mostly does both', () => {
    const ranked = [
      listing({ slug: 'always-wrong', published: { conformance: 0, availability: 1000 } }),
      listing({ slug: 'mostly-right', published: { conformance: 1000, availability: 958 } })
    ].sort(byReputation);
    expect(ranked.map((entry) => entry.slug)).toEqual(['mostly-right', 'always-wrong']);
  });

  it('ranks a service that never answers below one that mostly does both', () => {
    const ranked = [
      listing({ slug: 'always-down', published: { conformance: 1000, availability: 0 } }),
      listing({ slug: 'mostly-right', published: { conformance: 958, availability: 1000 } })
    ].sort(byReputation);
    expect(ranked.map((entry) => entry.slug)).toEqual(['mostly-right', 'always-down']);
  });

  it('treats the two ratios symmetrically', () => {
    const ranked = [
      listing({ slug: 'a', published: { conformance: 1000, availability: 900 } }),
      listing({ slug: 'b', published: { conformance: 900, availability: 1000 } })
    ].sort(byReputation);
    // Equal products, so the tie-break decides — neither metric outranks the other.
    expect(ranked.map((entry) => entry.slug)).toEqual(['a', 'b']);
  });

  it('breaks a tie on the bond, then the slug', () => {
    const ranked = [
      listing({ slug: 'b', deposit: 1n }),
      listing({ slug: 'a', deposit: 1n }),
      listing({ slug: 'c', deposit: 9n })
    ].sort(byReputation);
    expect(ranked.map((entry) => entry.slug)).toEqual(['c', 'a', 'b']);
  });
});

describe('rendering', () => {
  const build = async () =>
    loadMarketplace(
      deps({
        services: [service('weather', HONEST)],
        verdicts: [verdict(HONEST, 'FAIL', '0x02')],
        records: { weather: record({}) }
      })
    );

  it('renders the marketplace listing without a DOM', async () => {
    const html = renderApp(await build(), 'demo', 'marketplace', null);
    expect(html).toContain('weather.verdikt.eth');
    expect(html).toContain('demo data');
  });

  it('no longer shows platform stats on the marketplace listing itself', async () => {
    const html = renderApp(await build(), 'demo', 'marketplace', null);
    expect(html).not.toContain('class="figures"');
  });

  it('no longer shows a platform-stats skeleton while the marketplace is loading', async () => {
    const html = renderApp(null, 'demo', 'marketplace', null);
    expect(html).not.toContain('class="figures"');
  });

  it('removes the doubled rule above the listing left by the removed figures section', async () => {
    const html = renderApp(await build(), 'demo', 'marketplace', null);
    expect(html).toContain('class="listing flush"');
  });

  it('shows platform stats on the landing page once the marketplace has loaded', async () => {
    const html = renderApp(await build(), 'demo', 'landing', null);
    expect(html).toContain('class="figures"');
    expect(html).toContain('>services<');
  });

  it('renders a standalone service page without a DOM', async () => {
    const html = renderApp(await build(), 'demo', 'service', 'weather');
    expect(html).toContain('responds-within-5s');
    expect(html).toContain('back to the marketplace');
  });

  it('identifies standalone service details as seeded in demo mode', async () => {
    const html = renderApp(await build(), 'demo', 'service', 'weather');
    expect(html).toContain('Showing seeded data, not a live chain');
    expect(html).toContain('VITE_ARC_RPC_URL');
  });

  it('shows what a service promised alongside what it delivered', async () => {
    const { services } = await build();
    const html = renderDetail(services[0]);
    expect(html).toContain('What it promised');
    expect(html).toContain('What it delivered');
    expect(html).toContain('FAIL');
  });

  it('escapes text that came off a chain rather than injecting it', async () => {
    // Every string here is provider-authored: a slug, a URL, an SLA clause id.
    const { services } = await loadMarketplace(
      deps({
        services: [service('weather', HONEST)],
        records: { weather: record({ url: '"><img src=x onerror=alert(1)>' }) }
      })
    );
    const html = renderDetail(services[0]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('says plainly that a service with no traffic is presumed healthy', async () => {
    const { services } = await loadMarketplace(
      deps({ services: [service('weather', HONEST)], records: { weather: record({}) } })
    );
    expect(renderDetail(services[0])).toContain('presumed healthy');
  });
});

describe('which clause a verdict says broke', () => {
  /** @param {VerdictRecord[]} verdicts */
  const detail = async (verdicts) => {
    const { services } = await loadMarketplace(
      deps({ services: [service('weather', HONEST)], verdicts, records: { weather: record({}) } })
    );
    return renderDetail(services[0]);
  };

  it('names the clause, resolving the hash against the published SLA', async () => {
    const html = await detail([verdict(HONEST, 'FAIL', '0x02', clauseHash('responds-within-5s'))]);
    expect(html).toContain('responds-within-5s');
  });

  // The implicit clause is in no SLA — the validator rejects `id: "delivery"` —
  // so matching it against the declared ids would report it as an edit.
  it('names the implicit delivery clause, which no SLA declares', async () => {
    const html = await detail([verdict(HONEST, 'DOWN', '0x02', clauseHash(DELIVERY_CLAUSE))]);
    expect(html).toContain('>delivery<');
    expect(html).not.toContain('edited since');
  });

  it('says "status only" when a failure named no clause, not "—"', async () => {
    const html = await detail([verdict(HONEST, 'DOWN', '0x02', NO_CLAUSE)]);
    expect(html).toContain('status only');
  });

  // The provider can rewrite its SLA at any time, and old verdicts still point
  // at the ids that were in force. Silently rendering that as "no clause" would
  // hide exactly the edit worth seeing.
  it('says the SLA was edited when a named clause no longer exists', async () => {
    const html = await detail([verdict(HONEST, 'FAIL', '0x02', clauseHash('a-clause-since-removed'))]);
    expect(html).toContain('edited since');
  });

  it('leaves a PASS blank rather than claiming it broke nothing in particular', async () => {
    const html = await detail([verdict(HONEST, 'PASS', '0x02')]);
    expect(html).not.toContain('status only');
    expect(html).not.toContain('edited since');
  });

  // The page's whole claim is the comparison between the promise and the
  // delivery, and the clause id is the only thing joining the two halves.
  // Printing it twice without connecting them leaves the reader to do it.
  it('links a named clause to the record that declares it', async () => {
    const html = await detail([verdict(HONEST, 'FAIL', '0x02', clauseHash('responds-within-5s'))]);
    // `responds-within-5s` is the second clause of the honest fixture.
    expect(html).toContain('id="clause-1"');
    expect(html).toContain('href="#clause-1"');
  });

  // `delivery` is in no SLA by construction, and an edited-away clause is in
  // this one no longer. Neither has a record to send a reader to.
  it('leaves a clause the SLA does not declare unlinked', async () => {
    const implicit = await detail([verdict(HONEST, 'DOWN', '0x02', clauseHash(DELIVERY_CLAUSE))]);
    expect(implicit).not.toContain('href="#clause-');
    const edited = await detail([verdict(HONEST, 'FAIL', '0x02', clauseHash('a-clause-since-removed'))]);
    expect(edited).not.toContain('href="#clause-');
  });
});

// The one thing an agent operator takes off this page. It used to be a
// truncated `weather.verdikt.bond/…` in a key/value table, which is neither a
// URL you can use nor one you can select.
describe('the endpoint a service is called at', () => {
  /** @param {Partial<RegisteredService>} [overrides] */
  const detail = async (overrides = {}) => {
    const { services } = await loadMarketplace(
      deps({ services: [service('weather', HONEST, overrides)], records: { weather: record({}) } })
    );
    return renderDetail(services[0]);
  };

  it('gives the whole URL, not an elided one', async () => {
    const html = await detail();
    expect(html).toContain('https://weather.verdikt.bond');
    expect(html).not.toContain('verdikt.bond/…');
  });

  it('offers to copy it', async () => {
    expect(await detail()).toContain('class="copy"');
  });

  // A retired slug answers 503, and a suspended one answers 503 until the
  // bond is topped up. Offering to copy an address that cannot be called is
  // the page inviting a wasted request.
  it('withholds the copy control where the proxy will not route', async () => {
    for (const status of /** @type {ServiceStatus[]} */ (['DEREGISTERED', 'SUSPENDED'])) {
      const html = await detail({ status });
      expect(html).not.toContain('class="copy"');
      expect(html).toContain('503');
    }
  });
});

// Read off the ledger rather than asserted: this page never fetches a 402
// challenge, so the only price it can honestly report is the one its own
// verdicts recorded.
describe('what the page says a call costs', () => {
  /** @param {bigint[]} paid */
  const detail = async (paid) => {
    const { services } = await loadMarketplace(
      deps({
        services: [service('weather', HONEST)],
        verdicts: paid.map((paidAmount, index) => ({
          ...verdict(HONEST, 'PASS', `0x0${index}`),
          paidAmount
        })),
        records: { weather: record({}) }
      })
    );
    return renderDetail(services[0]);
  };

  it('reports the one figure every recorded call paid', async () => {
    const html = await detail([2500n, 2500n]);
    expect(html).toContain('0.0025');
    expect(html).toContain('What all 2 recorded calls paid');
  });

  it('reports a range when they differ, rather than picking one', async () => {
    const html = await detail([1n, 2_500_000n]);
    // The asset is set apart from the figure, so the range reads as far as its
              // upper bound — the split that used to drop everything after "0.000001".
              expect(html).toContain('0.000001 to 2.5');
    expect(html).toContain('The range across 2 recorded calls');
  });

  // The honest fixture's price clause promises 1 to 10000 minor units. A
  // ledger running outside that is exactly what the FAIL below it records,
  // and the page must not talk over its own table.
  it('claims the price sits inside the declared band only when it does', async () => {
    expect(await detail([2500n])).toContain('Inside the');
    expect(await detail([2_500_000n])).not.toContain('Inside the');
  });

  it('reports no price at all before the first call, rather than guessing one', async () => {
    const html = await detail([]);
    expect(html).toContain('Nothing has been called yet');
    expect(html).not.toContain('class="price"');
  });
});

// One Arc read feeds four pages, and every one of them used to wait behind it
// showing the marketplace's own skeleton: a Marketplace title and a grid of
// six rows, then a wholesale replacement by a page of another shape. A
// skeleton that is not the shape of its page is worse than no skeleton.
describe('what a page shows while the chain is still answering', () => {
  /**
   * @param {'marketplace'|'service'|'provider'|'how'} view
   * @param {string|null} [slug]
   * @param {string|null} [address]
   */
  const loading = (view, slug = null, address = null) => renderApp(null, 'live', view, slug, address);

  it('stands in for the service page, with the slug the URL already gave it', () => {
    const html = loading('service', 'weather');
    expect(html).toContain('Call it');
    expect(html).toContain('What it promised');
    expect(html).toContain('>weather<');
    // The listing grid is the marketplace skeleton's own shape; the word
    // itself is in the nav on every page.
    expect(html).not.toContain('class="listing flush"');
    // SSR splits the interpolated slug into its own part, so the live
            // region's text is asserted either side of it.
            expect(html).toContain('role="status"');
            expect(html).toContain('Loading ');
  });

  it('stands in for a provider console, with the address the URL already gave it', () => {
    const html = loading('provider', null, PROVIDER);
    expect(html).toContain(PROVIDER);
    expect(html).toContain('>bonded<');
    expect(html).not.toContain('class="listing flush"');
  });

  it('still stands in for the marketplace on the marketplace', () => {
    const html = loading('marketplace');
    expect(html).toContain('class="listing flush"');
    expect(html).toContain('Loading the marketplace');
  });

  // /how is prose about the mechanism and reads neither chain, so waiting
  // behind the marketplace only bought it a skeleton of a page it is not.
  it('does not make /how wait for a chain it never reads', () => {
    const html = loading('how');
    expect(html).toContain('Two chains, each for one reason');
    expect(html).not.toContain('class="bar"');
  });

  // The name cell carries the slug over its subname. A single bar left every
  // row a line short — a hundred pixels of listing moving on arrival.
  it('redacts a listing row at the height of a real one', () => {
    const html = loading('marketplace');
    expect(html.match(/<span class="cell name"><strong>/g)?.length).toBe(6);
    expect(html.match(/<small>/g)?.length).toBe(6);
  });
});

// Two rules that are true of every service on every reading — how a refund is
// sized, which window the published ratios cover — used to stand as
// paragraphs between the reader and the figures they came for. They are
// footnotes now: asked, not read past.
describe('the standing rules behind the figures', () => {
  /** @param {VerdictRecord[]} [verdicts] @param {Partial<ServiceRecord>} [rec] */
  const detail = async (verdicts = [], rec = {}) => {
    const { services } = await loadMarketplace(
      deps({ services: [service('weather', HONEST)], verdicts, records: { weather: record(rec) } })
    );
    return renderDetail(services[0]);
  };

  it('puts the refund rule in a tooltip anchored to the delivered heading', async () => {
    const html = await detail([verdict(HONEST, 'FAIL', '0x02')]);
    expect(html).toContain('id="delivered-help"');
    expect(html).toContain('for="delivered-help"');
    expect(html).toContain('capped at what they actually paid');
    expect(html).not.toContain('class="aside">A FAIL or DOWN');
  });

  it('puts the window and the bond’s job in a tooltip anchored to the figures', async () => {
    const html = await detail();
    expect(html).toContain('id="scores-help"');
    expect(html).toContain('for="scores-help"');
    expect(html).toContain('trailing');
    expect(html).not.toContain('class="provenance"');
  });

  // Nothing to explain about a ledger with no rows, and the reason the
  // figures are blank is a standing note rather than a footnote — a reader
  // looking at a dash is already asking the question.
  it('offers no refund footnote before the first verdict', async () => {
    expect(await detail()).not.toContain('delivered-help');
  });

  it('offers no figures footnote where the scores are unpublished', async () => {
    const html = await detail([], { conformance: null, availability: null });
    expect(html).not.toContain('scores-help');
    expect(html).toContain('No scores published yet');
  });

  // Hover alone strands every touch device on a page whose explanations it
  // cannot reach.
  it('opens on click and on keyboard focus, not on hover alone', async () => {
    expect(await detail()).toContain('trigger="hover focus click"');
  });
});

// The explorer reads the same Sepolia records this app does and shows who
// wrote each one, so it is the independent check on the ENS half of what
// every one of these pages claims.
describe('the subname’s link out to the ENS explorer', () => {
  const EXPLORER = 'https://explorer.ens.dev/weather.verdikt.eth';
  const build = () =>
    loadMarketplace(deps({ services: [service('weather', HONEST)], records: { weather: record({}) } }));

  it('is on the service page', async () => {
    const { services } = await build();
    expect(renderDetail(services[0])).toContain(EXPLORER);
  });

  it('is on the marketplace listing', async () => {
    expect(renderApp(await build(), 'demo', 'marketplace', null)).toContain(EXPLORER);
  });

  it('is on a provider console', async () => {
    expect(renderApp(await build(), 'demo', 'provider', null, PROVIDER)).toContain(EXPLORER);
  });

  // An anchor inside an anchor is not markup a browser keeps: the row's link
  // to the service page would swallow this one, or the parser would split the
  // row. The row is a div with a stretched link inside it instead.
  it('is not nested inside the listing row’s own link', async () => {
    const html = renderApp(await build(), 'demo', 'marketplace', null);
    expect(html).not.toContain('<a class="row"');
    expect(html).toContain('href="/services/weather"');
  });

  it('leaves the site, so it opens where it will not lose the page behind it', async () => {
    const { services } = await build();
    const html = renderDetail(services[0]);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});

// Two records that were at the top of the page and should not have been: the
// upstream URL an agent never types, and the ENS `address` record, which
// issue #37 took out of the request path and which "Pays to" claimed was
// where the money lands.
describe('the provenance block', () => {
  const build = async () => {
    const { services } = await loadMarketplace(
      deps({ services: [service('weather', HONEST)], records: { weather: record({}) } })
    );
    return renderDetail(services[0]);
  };

  it('keeps the upstream and the address record below the promise and the record', async () => {
    const html = await build();
    expect(html).toContain('On the record');
    expect(html.indexOf('What it delivered')).toBeLessThan(html.indexOf('On the record'));
    expect(html.indexOf('Relays to')).toBeGreaterThan(html.indexOf('What it delivered'));
  });

  it('does not call the address record a payout, because nothing checks it', async () => {
    const html = await build();
    expect(html).toContain('Address record');
    expect(html).not.toContain('Pays to');
    expect(html).toContain('not checked against the 402 challenge');
  });

  it('names the registry it read only where a chain was actually read', async () => {
    const { services } = await loadMarketplace(
      deps({ services: [service('weather', HONEST)], records: { weather: record({}) } })
    );
    expect(renderApp({ services, stats: /** @type {any} */ ({ windowSeconds: 86400 }) }, 'live', 'service', 'weather')).toContain(ARC.registry);
    expect(renderApp({ services, stats: /** @type {any} */ ({ windowSeconds: 86400 }) }, 'demo', 'service', 'weather')).not.toContain(ARC.registry);
  });
});

describe('the provider view', () => {
  const build = async () =>
    loadMarketplace(
      deps({
        services: [service('weather', HONEST), service('other', FLAKY, { provider: '0xBoB' })],
        verdicts: [verdict(HONEST, 'FAIL', '0x02')],
        refunds: [
          { serviceId: HONEST, requestId: '0x02', payer: '0x11', amount: 10n ** 18n, blockNumber: 1n }
        ],
        records: { weather: record({}), other: record({ slug: 'other', serviceId: FLAKY }) }
      })
    );

  it('narrows to one provider rather than being a second app', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, '0xA11ce00000000000000000000000000000000001');
    expect(html).toContain('weather');
    expect(html).not.toContain('>other<');
  });

  // "your bonds" only reads correctly to the provider. A console is a public
  // page, and this render has nobody connected — the visitor's wording.
  it('shows what has been refunded out of that provider’s own bonds', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, PROVIDER);
    expect(html).toContain('refunded from these bonds');
    expect(html).toContain('class="value fail"');
  });

  it('matches the address case-insensitively', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, '0xa11ce00000000000000000000000000000000001');
    expect(html).toContain('weather');
  });

  it('says so plainly when an address owns nothing', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, '0xdead00000000000000000000000000000000dead');
    expect(html).toContain('No services registered');
  });

  // The provider console is a listing now, full stop — SLA and bond
  // management live on the service's own page (Task 4), registration at
  // /register (Task 5). No mount of any kind belongs here, signed in or not.
  it('renders no write controls at all, signed in or not', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, PROVIDER);
    expect(html).toContain('weather');
    expect(html).not.toContain('wizard-mount');
    expect(html).not.toContain('sla-editor-mount');
    expect(html).not.toContain('bond-controls-mount');
  });

  it('rows link to the service page, the same as the marketplace listing', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, PROVIDER);
    expect(html).toContain('href="/services/weather"');
  });
});

// The provider console's one write-adjacent affordance: a link to /register,
// shown only on your own page. Whether that page lets you proceed is its own
// concern (Task 5) — this link must not itself require being signed in, or an
// owner who hasn't signed in yet would have no way to find registration.
// Registering acts on the signed-in wallet, so the button appears only where
// that wallet could actually use it: signed in, on its own console. A
// console belonging to someone else never offers it, however you arrived.
describe('the provider console’s "add a service" button', () => {
  const build = async () =>
    loadMarketplace(deps({ services: [service('weather', HONEST)], verdicts: [], records: { weather: record({}) } }));
  /** @param {any} account @param {any} session */
  const as = (account, session = null) => { wallet.account = account; wallet.session = session; };
  const session = { address: PROVIDER, expiresAt: Date.now() + 60_000 };

  afterEach(() => as(null, null));

  it('shows it to the signed-in owner of this console', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, session);
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(html).toContain('href="/register"');
  });

  it('withholds it from an owner who has connected but not signed in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, null);
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(html).not.toContain('href="/register"');
  });

  it('withholds it from a signed-in wallet viewing somebody else’s console', async () => {
    const other = '0xB0b0000000000000000000000000000000000002';
    as({ address: other, chainId: ARC.chainId }, { address: other, expiresAt: Date.now() + 60_000 });
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(html).not.toContain('href="/register"');
  });

  it('withholds it from an unconnected visitor', async () => {
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(html).not.toContain('href="/register"');
  });
});

// The rendering half of the pair main.js's providerAuthorization mounts
// against (Task 7): a section without a mount behind it is a dead control, a
// mount with no section around it is invisible. These four cases are the
// same four resolveProviderConsole's replacement in lit-app.js distinguishes,
// now asked of a single service rather than a whole console.
describe('who gets a service’s write controls', () => {
  const build = async () =>
    loadMarketplace(deps({ services: [service('weather', HONEST)], verdicts: [], records: { weather: record({}) } }));
  /** @param {any} account @param {any} session */
  const as = (account, session) => { wallet.account = account; wallet.session = session; };
  const signedIn = { address: PROVIDER, expiresAt: Date.now() + 60_000 };
  const controls = ['sla-editor-mount', 'bond-controls-mount'];
  /** @param {string} html */
  const present = (html) => controls.filter((id) => html.includes(id));

  afterEach(() => as(null, null));

  it('keeps the service page read-only and offers its owner the way in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, signedIn);
    const html = renderApp(await build(), 'live', 'service', 'weather');
    expect(present(html)).toEqual([]);
    expect(html).toContain('href="/services/weather/manage"');
    expect(html).toContain('Manage service');
  });
  it('offers the way in to the owner before they sign in, and to nobody else', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, null);
    expect(renderApp(await build(), 'live', 'service', 'weather')).toContain('Manage service');
    const other = '0xB0b0000000000000000000000000000000000002';
    as({ address: other, chainId: ARC.chainId }, { address: other, expiresAt: Date.now() + 60_000 });
    expect(renderApp(await build(), 'live', 'service', 'weather')).not.toContain('Manage service');
    as(null, null);
    expect(renderApp(await build(), 'live', 'service', 'weather')).not.toContain('Manage service');
  });
  it('gives them to the owner on the manage page, connected on a supported chain and signed in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, signedIn);
    const html = renderApp(await build(), 'live', 'manage', 'weather');
    expect(present(html)).toEqual(controls);
    expect(html).toContain('Manage weather');
  });
  it('withholds them from the owner until they sign in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, null);
    const html = renderApp(await build(), 'live', 'manage', 'weather');
    expect(present(html)).toEqual([]);
    expect(html).toContain('Enable provider actions');
  });
  it('withholds them on an unsupported chain, and says which way out', async () => {
    as({ address: PROVIDER, chainId: 1 }, signedIn);
    const html = renderApp(await build(), 'live', 'manage', 'weather');
    expect(present(html)).toEqual([]);
    expect(html).toContain('Switch network');
  });
  it('withholds them from a signed-in wallet opening somebody else’s manage page, naming the provider', async () => {
    const other = '0xB0b0000000000000000000000000000000000002';
    as({ address: other, chainId: ARC.chainId }, { address: other, expiresAt: Date.now() + 60_000 });
    const html = renderApp(await build(), 'live', 'manage', 'weather');
    expect(present(html)).toEqual([]);
    expect(html).not.toContain('Enable provider actions');
    expect(html).toContain(PROVIDER);
  });
  it('shows no write section at all in demo mode', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, signedIn);
    const html = renderApp(await build(), 'demo', 'manage', 'weather');
    expect(present(html)).toEqual([]);
    expect(html).toContain('seeded data');
  });
  it('says so when the manage page names a service that does not exist', async () => {
    const html = renderApp(await build(), 'live', 'manage', 'ghost');
    expect(html).toContain('No service found');
  });
});

describe('the registration page', () => {
  /** @param {any} account */
  const as = (account) => { wallet.account = account; };

  afterEach(() => as(null));

  it('renders with no marketplace loaded at all', () => {
    expect(renderApp(null, 'live', 'register', null)).toContain('List a service');
  });

  it('prompts a visitor with no wallet connected to connect one', () => {
    const html = renderApp(null, 'live', 'register', null);
    expect(html).toContain('Connect a wallet');
    expect(html).not.toContain('wizard-mount');
  });

  it('prompts a connected but unsigned wallet to sign in, not the wizard', () => {
    as({ address: '0xA11ce00000000000000000000000000000000001', chainId: ARC.chainId });
    const html = renderApp(null, 'live', 'register', null);
    expect(html).toContain('Enable provider actions');
    expect(html).not.toContain('wizard-mount');
  });

  it('mounts the wizard for a signed-in, supported-chain wallet', () => {
    as({ address: '0xA11ce00000000000000000000000000000000001', chainId: ARC.chainId });
    wallet.session = { address: '0xA11ce00000000000000000000000000000000001', expiresAt: Date.now() + 60_000 };
    const html = renderApp(null, 'live', 'register', null);
    expect(html).toContain('wizard-mount');
    wallet.session = null;
  });

  it('shows a demo-mode notice instead of a wallet prompt', () => {
    const html = renderApp(null, 'demo', 'register', null);
    expect(html).toContain('List a service');
    expect(html).not.toContain('wizard-mount');
  });
});

// /provider with nothing usable in the path. The old behaviour was to render
// the marketplace here, under a Provider title.
describe('the address-less provider page', () => {
  const build = async () =>
    loadMarketplace(deps({ services: [service('weather', HONEST)], verdicts: [], records: { weather: record({}) } }));

  it('shows no provider data and no listing', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, null);
    expect(html).toContain('No provider selected');
    expect(html).not.toContain('weather');
    expect(html).not.toContain('class="figures"');
  });

  it('names what it rejected, without looking it up', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, null, 'foo');
    expect(html).toContain('is not a wallet address');
    expect(html).toContain('foo');
    expect(html).not.toContain('weather');
  });

  // Two in live mode: the nav's and the page's own. Demo mode has neither —
  // a console reads Arc, and demo data comes from no chain at all.
  it('offers a connect button only where a wallet can be connected', async () => {
    const live = renderApp(await build(), 'live', 'provider', null, null);
    expect(live.match(/Connect wallet/g)).toHaveLength(2);
    expect(renderApp(await build(), 'demo', 'provider', null, null)).not.toContain('Connect wallet');
  });

  // It reads nothing off a chain, so a dead RPC must not take it down with
  // the marketplace — the same rule the legal pages already follow.
  it('renders with no marketplace loaded at all', () => {
    expect(renderApp(null, 'live', 'provider', null, null)).toContain('No provider selected');
  });
});
