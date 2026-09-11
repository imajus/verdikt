import { describe, expect, it } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { landing, newestVerdict } from './landing.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('');

/** @param {Partial<ListingVerdict>} overrides @returns {ListingVerdict} */
const verdict = (overrides) => ({
  serviceId: `0x${'11'.repeat(32)}`,
  requestId: `0x${'ab'.repeat(32)}`,
  outcome: 'PASS',
  payer: '0xA11ce00000000000000000000000000000000001',
  paidAmount: 1000n,
  failedClause: `0x${'00'.repeat(32)}`,
  blockNumber: 100n,
  transactionHash: null,
  refunded: 0n,
  failedClauseId: null,
  ...overrides
});

/** @param {string} slug @param {ListingVerdict[]} history @returns {Listing} */
const listing = (slug, history) => ({
  serviceId: `0x${'11'.repeat(32)}`,
  slug,
  name: `${slug}.verdikt.eth`,
  provider: '0xA11ce00000000000000000000000000000000001',
  status: 'ACTIVE',
  deposit: 10n * 10n ** 18n,
  endpoint: 'https://provider.example/weather',
  payTo: '0x2222222222222222222222222222222222222222',
  namingLayer: 'ok',
  contested: false,
  sla: null,
  slaRaw: null,
  published: { conformance: 1000, availability: 1000 },
  unpublished: { conformance: 1000, availability: 1000, counts: { pass: history.length, fail: 0, down: 0, total: history.length } },
  history
});

/** @param {Listing[]} services @returns {Marketplace} */
const marketplace = (services) => ({
  services,
  stats: {
    services: services.length,
    active: services.length,
    suspended: 0,
    bonded: 20n * 10n ** 18n,
    verdicts: services.reduce((total, service) => total + service.history.length, 0),
    breakdown: { PASS: 2, FAIL: 1, DOWN: 0 },
    refundCount: 1,
    refunded: 5n * 10n ** 17n,
    windowSeconds: 604800
  }
});

describe('landing page', () => {
  it('leads with a marketplace call to action', () => {
    const html = stringify(landing(() => {}));
    expect(html).toContain('Browse the marketplace');
    expect(html).toContain('/marketplace');
  });

  it('puts the hero above the platform figures', () => {
    const html = stringify(landing(() => {}, marketplace([listing('weather', [verdict({})])])));
    expect(html.indexOf('No arbitration')).toBeGreaterThan(-1);
    expect(html.indexOf('No arbitration')).toBeLessThan(html.indexOf('class="figures"'));
  });

  it('carries every section the page promises, in order', () => {
    const html = stringify(landing(() => {}, marketplace([listing('weather', [verdict({})])])));
    const order = [
      'No arbitration',
      'class="figures"',
      'The payment is verifiable',
      'The request path',
      'verdikt-subscribe',
      'verdikt-contact'
    ].map((needle) => html.indexOf(needle));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // Every number on this page is read off a chain. A figure rendered before the
  // first read resolves would be a fabricated one, so the skeleton is the only
  // thing allowed to stand in for it.
  it('shows redacted figures rather than numbers before the chain has answered', () => {
    const html = stringify(landing(() => {}));
    expect(html).toContain('figure skeleton');
    expect(html).toContain('Reading the registry…');
  });

  // Bars that never resolve are a placeholder pretending to be a pending
  // number. A read that already failed says so.
  it('replaces the redacted figures with the failure once the read has failed', () => {
    const html = stringify(landing(() => {}, null, 'live', 'HTTP request failed'));
    expect(html).not.toContain('figure skeleton');
    expect(html).toContain('could not be read');
    expect(html).toContain('HTTP request failed');
    expect(html).not.toContain('Reading the registry…');
  });

  it('reports the newest verdict across every service, not the first listing’s', () => {
    const older = verdict({ blockNumber: 100n, outcome: 'PASS' });
    const newer = verdict({ blockNumber: 220n, outcome: 'FAIL', refunded: 10n ** 17n, failedClauseId: 'responds-within-5s' });
    const found = newestVerdict(marketplace([listing('weather', [older]), listing('quotes', [newer])]));
    expect(found?.slug).toBe('quotes');
    expect(found?.verdict.blockNumber).toBe(220n);
  });

  it('ignores a verdict with no block rather than ranking it newest', () => {
    const pending = verdict({ blockNumber: null });
    const mined = verdict({ blockNumber: 5n });
    expect(newestVerdict(marketplace([listing('weather', [pending, mined])]))?.verdict.blockNumber).toBe(5n);
  });

  it('renders the newest verdict in the margin with what it paid and refunded', () => {
    const html = stringify(landing(() => {}, marketplace([listing('quotes', [verdict({ blockNumber: 220n, outcome: 'FAIL', refunded: 10n ** 17n })])]), 'live'));
    expect(html).toContain('Latest verdict');
    expect(html).toContain('FAIL');
    expect(html).toContain('220');
    expect(html).toContain('0.1 USDC');
  });

  it('flags seeded data as seeded and never as a live chain', () => {
    const demo = stringify(landing(() => {}, marketplace([listing('weather', [verdict({})])]), 'demo'));
    expect(demo).toContain('seeded');
    expect(demo).toContain('VITE_ARC_RPC_URL');
    const live = stringify(landing(() => {}, marketplace([listing('weather', [verdict({})])]), 'live'));
    expect(live).toContain('Arc Testnet');
    expect(live).not.toContain('Seeded demo data');
  });

  // Both margins answer "was a chain read"; they must not answer it differently
  // on the same render.
  it('names a chain address in every margin or in none, never in one of two', () => {
    const services = marketplace([listing('weather', [verdict({})])]);
    const demo = stringify(landing(() => {}, services, 'demo'));
    expect(demo).not.toMatch(/0x[0-9a-fA-F]{40}/);
    const live = stringify(landing(() => {}, services, 'live'));
    const addresses = live.match(/0x[0-9a-fA-F]{40}/g) ?? [];
    expect(addresses.length).toBeGreaterThanOrEqual(2);
    expect(new Set(addresses).size).toBe(1);
  });

  it('offers the provider console only where a chain is configured to register on', () => {
    const services = marketplace([listing('weather', [verdict({})])]);
    expect(stringify(landing(() => {}, services, 'live'))).toContain('list a service of your own');
    expect(stringify(landing(() => {}, services, 'demo'))).not.toContain('list a service of your own');
  });

  it('says a service nobody has called is presumed healthy rather than showing a zero', () => {
    const html = stringify(landing(() => {}, marketplace([listing('weather', [])])));
    expect(html).toContain('presumed healthy');
    expect(html).not.toContain('note-kv');
  });
});
