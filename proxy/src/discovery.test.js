import { describe, expect, it } from 'vitest';
import { call } from './test-support.js';
import { loadConfig } from './config.js';
import { discover, toListing } from './discovery.js';

const config = loadConfig({ PROXY_PUBLIC_HOST: 'verdikt.bond', VERDIKT_REGISTRY_ADDRESS: '0x01' });

/** @param {Partial<Listing>} [overrides] @returns {Listing} */
const listing = (overrides = {}) =>
  /** @type {Listing} */ ({
    slug: 'weather',
    name: 'weather.verdikt.eth',
    serviceId: `0x${'11'.repeat(32)}`,
    provider: '0xA11ce00000000000000000000000000000000001',
    status: 'ACTIVE',
    deposit: 10n * 10n ** 18n,
    endpoint: 'https://provider.example/weather',
    payTo: '0x2222222222222222222222222222222222222222',
    namingLayer: 'ok',
    slaRaw: '{}',
    sla: {
      version: 1,
      clauses: [
        { id: 'shape', type: 'schema', schema: { type: 'object' } },
        { id: 'speed', type: 'latency', maxMs: 5000 },
        { id: 'price', type: 'priceRange', minMinorUnits: '1000', maxMinorUnits: '10000', asset: 'USDC' }
      ]
    },
    published: { conformance: 1000, availability: 958 },
    unpublished: { conformance: 1000, availability: 958, counts: { pass: 0, fail: 0, down: 0, total: 0 } },
    history: [],
    ...overrides
  });

/**
 * @param {Record<string, string|undefined>} query
 * @param {Listing[]} [listings]
 */
const find = (query, listings = [listing()]) => discover(listings, query, 'verdikt.bond');

describe('toListing', () => {
  it('gives an agent the URL it would actually call', () => {
    expect(toListing(listing(), 'verdikt.bond').endpoint).toBe('https://weather.verdikt.bond');
  });

  it('surfaces the bounds an agent chooses on, from the SLA', () => {
    expect(toListing(listing(), 'verdikt.bond').sla).toMatchObject({
      maxLatencyMs: 5000,
      minPriceMinorUnits: '1000',
      maxPriceMinorUnits: '10000',
      asset: 'USDC'
    });
  });

  it('renders the bond as a decimal string, since JSON has no bigint', () => {
    expect(toListing(listing(), 'verdikt.bond').bond).toBe('10000000000000000000');
  });

  it('reports how many verdicts a ratio rests on', () => {
    // A 1000 from one call is not a 1000 from a thousand, and an agent picking
    // on reputation needs to be able to tell.
    const withHistory = listing({ history: /** @type {never} */ ([{}, {}, {}]) });
    expect(toListing(withHistory, 'verdikt.bond').reputation.verdicts).toBe(3);
  });

  it('says nothing about a service that published no SLA', () => {
    const entry = toListing(listing({ sla: null }), 'verdikt.bond');
    expect(entry.sla).toMatchObject({ maxLatencyMs: null, maxPriceMinorUnits: null, clauses: [] });
  });
});

describe('discover — filtering', () => {
  it('returns everything with no filter', () => {
    expect(find({}).count).toBe(1);
  });

  it('filters on published reputation', () => {
    expect(find({ minConformance: '1000' }).count).toBe(1);
    expect(find({ minAvailability: '990' }).count).toBe(0);
  });

  // The dashboard presumes a quiet service healthy because a human sees the
  // caveat beside it. An agent asking for minConformance=990 is asking for
  // evidence, and "no evidence yet" is not evidence.
  it('excludes an unpublished score from a minimum rather than passing it', () => {
    const unranked = [listing({ published: { conformance: null, availability: null } })];
    expect(find({ minConformance: '1' }, unranked).count).toBe(0);
    expect(find({}, unranked).count).toBe(1);
  });

  it('filters on the latency a service promises, excluding those that promise none', () => {
    expect(find({ maxLatencyMs: '5000' }).count).toBe(1);
    expect(find({ maxLatencyMs: '4999' }).count).toBe(0);
    expect(find({ maxLatencyMs: '9999' }, [listing({ sla: null })]).count).toBe(0);
  });

  it('compares price in integer minor units, not floats', () => {
    expect(find({ maxPriceMinorUnits: '10000' }).count).toBe(1);
    expect(find({ maxPriceMinorUnits: '9999' }).count).toBe(0);
    // Beyond 2^53, where a float would silently agree with itself.
    const dear = [listing({ sla: { version: 1, clauses: [{ id: 'p', type: 'priceRange', minMinorUnits: '1', maxMinorUnits: '9007199254740993', asset: 'USDC' }] } })];
    expect(find({ maxPriceMinorUnits: '9007199254740992' }, dear).count).toBe(0);
    expect(find({ maxPriceMinorUnits: '9007199254740993' }, dear).count).toBe(1);
  });

  it('filters on status', () => {
    expect(find({ status: 'active' }).count).toBe(1);
    expect(find({ status: 'suspended' }).count).toBe(0);
  });

  it('explains what null means, in the response itself', () => {
    expect(find({}).note).toMatch(/null means the hourly run has not written/);
  });
});

describe('the routes', () => {
  /** @param {(() => Promise<Marketplace>)|null} marketplace @returns {ProxyDeps} */
  const deps = (marketplace) => ({
    config,
    marketplace,
    registry: { getService: async () => ({ provider: '0x0', status: 'ACTIVE', deposit: 0n }) },
    resolveServiceRecord: async () => {
      throw new Error('unused');
    }
  });

  const ok = async () => ({ services: [listing()], stats: /** @type {never} */ ({}) });

  it('lists the marketplace', async () => {
    const response = await call(deps(ok), { method: 'GET', url: '/services', headers: { host: 'proxy.local' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().services[0].slug).toBe('weather');
  });

  it('applies query filters', async () => {
    const response = await call(deps(ok), {
      method: 'GET',
      url: '/services?minAvailability=990',
      headers: { host: 'proxy.local' }
    });
    expect(response.json().count).toBe(0);
  });

  it('serves one service, and 404s an unknown slug', async () => {
    const instance = deps(ok);
    expect((await call(instance, { method: 'GET', url: '/services/weather', headers: { host: 'proxy.local' } })).json().slug).toBe('weather');
    expect((await call(instance, { method: 'GET', url: '/services/nope', headers: { host: 'proxy.local' } })).statusCode).toBe(404);
  });

  it('is matched ahead of the service catch-all, not read as a slug', async () => {
    // Without exact routes, `/services` would be relayed to a provider named
    // "services" — or 404 as an unknown one.
    const response = await call(deps(ok), { method: 'GET', url: '/services', headers: { host: 'proxy.local' } });
    expect(response.json().count).toBe(1);
  });

  it('503s rather than pretending the marketplace is empty', async () => {
    expect((await call(deps(null), { method: 'GET', url: '/services', headers: { host: 'proxy.local' } })).statusCode).toBe(503);
    const broken = async () => {
      throw new Error('arc down');
    };
    expect((await call(deps(broken), { method: 'GET', url: '/services', headers: { host: 'proxy.local' } })).statusCode).toBe(503);
  });
});
