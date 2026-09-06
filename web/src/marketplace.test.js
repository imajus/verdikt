import { describe, expect, it } from 'vitest';
import { SLA_TEXT } from '@verdikt/fixtures';
import { formatMinorUsdc, formatNativeUsdc, formatScore, scoreBand, shortHex } from './format.js';
import { byReputation, loadMarketplace } from './marketplace.js';
import { renderApp, renderDetail } from './render.js';

const HONEST = `0x${'11'.repeat(32)}`;
const FLAKY = `0x${'22'.repeat(32)}`;

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
 * @returns {VerdictRecord}
 */
const verdict = (serviceId, outcome, requestId) => ({
  serviceId,
  requestId,
  outcome,
  payer: '0x1111111111111111111111111111111111111111',
  paidAmount: 2500n,
  blockNumber: 10n,
  transactionHash: `0x${'ab'.repeat(32)}`
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

  it('renders the whole page without a DOM', async () => {
    const html = renderApp(await build(), 'demo', 'weather');
    expect(html).toContain('weather.verdikt.eth');
    expect(html).toContain('demo data');
    expect(html).toContain('responds-within-5s');
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
