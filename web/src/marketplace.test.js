import { afterEach, describe, expect, it, vi } from 'vitest';
import { SLA_TEXT } from '@verdikt/fixtures';
import { ARC } from '@verdikt/sdk';
import { DELIVERY_CLAUSE, NO_CLAUSE, clauseHash } from '@verdikt/sdk/registry';
import { formatMinorUsdc, formatNativeUsdc, formatScore, scoreBand, shortHex } from './format.js';
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
    expect(html).toContain('1 USDC');
  });

  it('matches the address case-insensitively', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, '0xa11ce00000000000000000000000000000000001');
    expect(html).toContain('weather');
  });

  it('says so plainly when an address owns nothing', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, '0xdead00000000000000000000000000000000dead');
    expect(html).toContain('No services registered');
    expect(html).not.toContain('sla-editor-mount');
    expect(html).not.toContain('bond-controls-mount');
  });

  // A console is a public page, so a visitor sees the record and nothing to
  // act on it with. No wallet is connected in this render, which is exactly
  // the case: the write sections are absent, not disabled.
  it('renders no write controls for anyone but the signed-in owner', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, PROVIDER);
    expect(html).toContain('weather');
    expect(html).not.toContain('wizard-mount');
    expect(html).not.toContain('sla-editor-mount');
    expect(html).not.toContain('bond-controls-mount');
  });
});

// The rendering half of the pair main.js's providerAuthorization mounts
// against: a section without a mount behind it is a dead control, a mount
// with no section around it is an invisible one. These four cases are the
// same four that function distinguishes.
describe('who gets the provider console’s write controls', () => {
  const build = async () =>
    loadMarketplace(deps({ services: [service('weather', HONEST)], verdicts: [], records: { weather: record({}) } }));
  /** @param {any} account @param {any} session */
  const as = (account, session) => { wallet.account = account; wallet.session = session; };
  const signedIn = { address: PROVIDER, expiresAt: Date.now() + 60_000 };
  const controls = ['wizard-mount', 'sla-editor-mount', 'bond-controls-mount'];
  /** @param {string} html */
  const present = (html) => controls.filter((id) => html.includes(id));

  afterEach(() => as(null, null));

  it('gives them to the owner, connected on a supported chain and signed in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, signedIn);
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(present(html)).toEqual(controls);
    expect(html).toContain('refunded from your bonds');
  });
  it('withholds them from the owner until they sign in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, null);
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(present(html)).toEqual([]);
    expect(html).toContain('Enable provider actions');
  });
  it('withholds them on an unsupported chain, and says which way out', async () => {
    as({ address: PROVIDER, chainId: 1 }, signedIn);
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(present(html)).toEqual([]);
    expect(html).toContain('Switch network');
  });
  it('withholds them from a signed-in wallet viewing somebody else’s console', async () => {
    const other = '0xB0b0000000000000000000000000000000000002';
    as({ address: other, chainId: ARC.chainId }, { address: other, expiresAt: Date.now() + 60_000 });
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(present(html)).toEqual([]);
    expect(html).not.toContain('Enable provider actions');
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
