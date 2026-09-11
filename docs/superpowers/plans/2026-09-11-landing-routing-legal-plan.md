# Landing page, real routes, and legal pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's query-param view toggle with real URL paths, add a landing page, extract service detail into its own page, redirect to the provider console after an explicit wallet connect, and add static Terms/Privacy pages.

**Architecture:** `web/src/router.js` becomes a pure pathname parser (`parseRoute`) instead of a query-param reader, with path-builder helpers and a `titleFor` function. All dashboard navigation collapses onto a single `navigate` custom event carrying a path string, handled once in `main.js` via `history.pushState`/`replaceState` + a `popstate` listener. `web/src/pages.js` is a new file holding the landing/terms/privacy templates and a shared legal footer. `web/src/lit-app.js` drops the marketplace's split-screen detail panel in favor of a standalone service page, reusing the existing `detailTemplate`. Both static-hosting deploy targets (`web/wrangler.jsonc`, `web/Dockerfile`'s nginx) get an SPA fallback so a hard refresh on a real path doesn't 404.

**Tech Stack:** Lit 3 (no framework router), Vite, Vitest (Node environment, no jsdom), `@lit-labs/ssr` for string-rendering tests, Cloudflare Workers assets, nginx/Docker.

## Global Constraints

- JS/ESM throughout, no TypeScript. Ambient types live in `web/types.d.ts` (no `export`); JSDoc references them.
- `vitest.config.js` runs with `environment: 'node'` — no DOM globals exist unless a test stubs them with `vi.stubGlobal`.
- The `?provider=0x…` deep link is the one query param documented as a public, shareable link and must keep resolving to the right page (redirected forward to `/provider/0x…`, not merely tolerated in place).
- No dynamic per-route `<meta>`/OG tag changes — only `document.title` is updated per route.
- Run tests with `pnpm vitest run <path>` from the repo root (single shared root config, see `CLAUDE.md`).
- Design reference: `docs/superpowers/specs/2026-09-11-landing-routing-legal-design.md`.

---

## Task 1: Router rewrite — pathname parsing, path builders, title

**Files:**
- Modify: `web/src/router.js` (full rewrite)
- Test: `web/src/router.test.js` (full rewrite)

**Interfaces:**
- Produces: `parseRoute(url: URL) => { view: 'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy', slug: string|null, address: string|null, canonicalPath: string }`, `serviceUrl(slug: string) => string`, `providerUrl(address: string) => string`, `titleFor(route) => string`, and path constants `LANDING_PATH`, `MARKETPLACE_PATH`, `PROVIDER_PATH`, `HOW_PATH`, `TERMS_PATH`, `PRIVACY_PATH`.
- Consumes: nothing from elsewhere in the app.

- [ ] **Step 1: Replace `web/src/router.test.js` with the new pathname-based tests**

```js
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_PATH, parseRoute, providerUrl, serviceUrl, titleFor } from './router.js';

describe('parseRoute', () => {
  it('reads the landing path', () => {
    expect(parseRoute(new URL('https://verdikt.example/'))).toEqual({ view: 'landing', slug: null, address: null, canonicalPath: '/' });
  });
  it('reads the marketplace path', () => {
    expect(parseRoute(new URL('https://verdikt.example/marketplace'))).toEqual({ view: 'marketplace', slug: null, address: null, canonicalPath: '/marketplace' });
  });
  it('reads a service path', () => {
    expect(parseRoute(new URL('https://verdikt.example/services/weather'))).toEqual({ view: 'service', slug: 'weather', address: null, canonicalPath: '/services/weather' });
  });
  it('decodes an encoded slug', () => {
    expect(parseRoute(new URL('https://verdikt.example/services/weather%20api')).slug).toBe('weather api');
  });
  it('reads the own provider console path', () => {
    expect(parseRoute(new URL('https://verdikt.example/provider'))).toEqual({ view: 'provider', slug: null, address: null, canonicalPath: '/provider' });
  });
  it('reads a shared provider path', () => {
    expect(parseRoute(new URL('https://verdikt.example/provider/0xAaAa'))).toEqual({ view: 'provider', slug: null, address: '0xAaAa', canonicalPath: '/provider/0xAaAa' });
  });
  it('reads the how, terms and privacy paths', () => {
    expect(parseRoute(new URL('https://verdikt.example/how')).view).toBe('how');
    expect(parseRoute(new URL('https://verdikt.example/terms')).view).toBe('terms');
    expect(parseRoute(new URL('https://verdikt.example/privacy')).view).toBe('privacy');
  });
  it('tolerates a trailing slash', () => {
    expect(parseRoute(new URL('https://verdikt.example/marketplace/')).view).toBe('marketplace');
  });
  it('falls back to the marketplace, with a redirect, for an unrecognised path', () => {
    const route = parseRoute(new URL('https://verdikt.example/nonsense'));
    expect(route.view).toBe('marketplace');
    expect(route.canonicalPath).toBe(MARKETPLACE_PATH);
  });
  it('rewrites the legacy ?provider= deep link forward, regardless of path', () => {
    const route = parseRoute(new URL('https://verdikt.example/?provider=0xAaAa'));
    expect(route).toEqual({ view: 'provider', slug: null, address: '0xAaAa', canonicalPath: '/provider/0xAaAa' });
  });
});

describe('serviceUrl / providerUrl', () => {
  it('builds a service path, encoding the slug', () => {
    expect(serviceUrl('weather api')).toBe('/services/weather%20api');
  });
  it('builds a provider path', () => {
    expect(providerUrl('0xAaAa')).toBe('/provider/0xAaAa');
  });
});

describe('titleFor', () => {
  it('titles the static views', () => {
    expect(titleFor(parseRoute(new URL('https://verdikt.example/marketplace')))).toBe('Marketplace — Verdikt');
    expect(titleFor(parseRoute(new URL('https://verdikt.example/how')))).toBe('How it works — Verdikt');
  });
  it('titles a service page with its slug', () => {
    expect(titleFor(parseRoute(new URL('https://verdikt.example/services/weather')))).toBe('weather — Verdikt');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run web/src/router.test.js`
Expected: FAIL — `parseRoute`, `serviceUrl`, `providerUrl`, `titleFor` are not exported by the current `router.js` (which exports `readRoute`/`withService`/`withProvider`/`withView`).

- [ ] **Step 3: Replace `web/src/router.js` with the pathname-based implementation**

```js
// The one place the dashboard shapes its own URL. Real paths, not query
// params (docs/superpowers/specs/2026-09-11-landing-routing-legal-design.md
// §1): both static-hosting targets (web/wrangler.jsonc's
// not_found_handling, web/nginx.conf's try_files) resolve any unmatched
// path to index.html, which is what makes a hard refresh on e.g.
// /marketplace work.
//
// Every function here is pure: takes a URL, returns a value, and never
// touches `location`/`history` itself — the one caller that has a real
// `location`/`history` (main.js) is the one that acts on `canonicalPath`.
// That is what keeps this file testable in plain Node.
//
// `?provider=0x…` predates path-based routing and was a public, shareable
// deep link to any provider's page. parseRoute still reads it, but always
// returns the canonical `/provider/0x…` path so main.js can rewrite the
// address bar forward.

export const LANDING_PATH = '/';
export const MARKETPLACE_PATH = '/marketplace';
export const PROVIDER_PATH = '/provider';
export const HOW_PATH = '/how';
export const TERMS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';

const STATIC_VIEWS = /** @type {Record<string, string>} */ ({
  '/': 'landing',
  [MARKETPLACE_PATH]: 'marketplace',
  [HOW_PATH]: 'how',
  [TERMS_PATH]: 'terms',
  [PRIVACY_PATH]: 'privacy'
});

/** @param {string} slug */
export function serviceUrl(slug) {
  return `/services/${encodeURIComponent(slug)}`;
}

/** @param {string} address */
export function providerUrl(address) {
  return `${PROVIDER_PATH}/${address}`;
}

/** @param {string} pathname */
function normalize(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

/**
 * @param {URL} url
 * @returns {{
 *   view: 'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy',
 *   slug: string|null,
 *   address: string|null,
 *   canonicalPath: string
 * }}
 */
export function parseRoute(url) {
  const legacyProvider = url.searchParams.get('provider');
  if (legacyProvider) return { view: 'provider', slug: null, address: legacyProvider, canonicalPath: providerUrl(legacyProvider) };

  const path = normalize(url.pathname);
  const staticView = STATIC_VIEWS[path];
  if (staticView) return { view: /** @type {any} */ (staticView), slug: null, address: null, canonicalPath: path };

  const service = path.match(/^\/services\/([^/]+)$/);
  if (service) return { view: 'service', slug: decodeURIComponent(service[1]), address: null, canonicalPath: path };

  if (path === PROVIDER_PATH) return { view: 'provider', slug: null, address: null, canonicalPath: path };
  const provider = path.match(/^\/provider\/(.+)$/);
  if (provider) return { view: 'provider', slug: null, address: provider[1], canonicalPath: path };

  // A typo or an old bookmark to a path that never existed isn't worth a
  // dedicated 404 view — send it to the listing.
  return { view: 'marketplace', slug: null, address: null, canonicalPath: MARKETPLACE_PATH };
}

const TITLES = /** @type {Record<string, string>} */ ({
  landing: 'Verdikt — Verified x402 API Marketplace',
  marketplace: 'Marketplace — Verdikt',
  provider: 'Provider — Verdikt',
  how: 'How it works — Verdikt',
  terms: 'Terms — Verdikt',
  privacy: 'Privacy — Verdikt'
});

/** @param {ReturnType<typeof parseRoute>} route */
export function titleFor(route) {
  if (route.view === 'service') return `${route.slug} — Verdikt`;
  return TITLES[route.view] ?? 'Verdikt';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run web/src/router.test.js`
Expected: PASS (all cases in Step 1)

- [ ] **Step 5: Commit**

```bash
git add web/src/router.js web/src/router.test.js
git commit -m "Rewrite the dashboard router around real URL paths"
```

---

## Task 2: Static pages module — landing, terms, privacy, legal footer

**Files:**
- Create: `web/src/pages.js`
- Test: `web/src/pages.test.js`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: nothing (pure Lit templates; no import from `router.js` or `lit-app.js` needed — hrefs are written as literal strings to avoid any risk of a circular import with `lit-app.js`, which will import from this file in Task 3).
- Produces: `TAGLINE` (string, moved here from `lit-app.js`), `landing(go: (path: string) => void)`, `terms()`, `privacy()`, `legalFooter(go: (path: string) => void)` — all return Lit `TemplateResult`.

- [ ] **Step 1: Write `web/src/pages.test.js`**

```js
import { describe, expect, it } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { landing, legalFooter, privacy, terms } from './pages.js';

const stringify = (template) => Array.from(renderToIterable(template)).join('');

describe('static pages', () => {
  it('renders the landing page with a marketplace call to action', () => {
    const html = stringify(landing(() => {}));
    expect(html).toContain('Browse the marketplace');
    expect(html).toContain('/marketplace');
  });
  it('renders terms and privacy with distinct headings', () => {
    expect(stringify(terms())).toContain('Terms of Service');
    expect(stringify(privacy())).toContain('Privacy Policy');
  });
  it('renders a footer with both legal links', () => {
    const html = stringify(legalFooter(() => {}));
    expect(html).toContain('/terms');
    expect(html).toContain('/privacy');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run web/src/pages.test.js`
Expected: FAIL — `web/src/pages.js` does not exist yet.

- [ ] **Step 3: Create `web/src/pages.js`**

```js
// Static content the dashboard shows with no chain data behind it: the
// landing page, the legal pages, and the footer linking to them. Kept apart
// from lit-app.js's marketplace/provider/how templates because none of these
// need `Marketplace`/`Listing` data or a loaded route — see
// docs/superpowers/specs/2026-09-11-landing-routing-legal-design.md §3, §7.

import { html } from 'lit';

export const TAGLINE = 'x402 services whose delivery is verified per call. Every response is judged against the SLA its provider published; a broken promise refunds the caller from the provider’s bond.';

/** @param {(path: string) => void} go @param {string} path */
const follow = (go, path) => (/** @type {Event} */ event) => { event.preventDefault(); go(path); };

/** @param {(path: string) => void} go */
export const landing = (go) => html`
  <header class="masthead">
    <div>
      <h1><a class="brand" href="/" aria-label="Verdikt home" @click=${follow(go, '/')}><img class="brand-mark" src="/favicon.svg" alt="" width="42" height="42" /><span>Verdikt</span></a></h1>
      <p class="tagline">${TAGLINE}</p>
    </div>
  </header>
  <p class="landing-cta">
    <wa-button href="/marketplace" @click=${follow(go, '/marketplace')}>Browse the marketplace</wa-button>
  </p>`;

export const terms = () => html`
  <h2 class="page-title">Terms of Service</h2>
  <p class="aside">Last updated 2026-09-11. This is a hackathon demo — the text below is a plain description of what the app does, not reviewed legal advice.</p>
  <section class="block">
    <h3>What Verdikt is</h3>
    <p>Verdikt is a demo marketplace of x402-gated API services. It has no backend and no accounts: this page reads Arc Testnet and Ethereum Sepolia directly from your browser, and every write — registering a service, publishing an SLA, connecting a wallet — is a transaction you sign yourself. Verdikt never holds a key of yours and never takes custody of funds.</p>
  </section>
  <section class="block">
    <h3>No warranty</h3>
    <p>Everything here — listings, scores, verdicts, refunds — is provided as-is, for demonstration purposes, with no warranty of any kind. A verdict written by the verification workflow is final by design (see <a href="/how">how it works</a>); Verdikt is not a party to, and takes no responsibility for, any agreement between a provider and a caller.</p>
  </section>
  <section class="block">
    <h3>Use at your own risk</h3>
    <p>Testnet assets have no value. If Verdikt is ever used against a live network, you are responsible for your own wallet, keys and transactions. Do not rely on this software for anything where a bug or an outage would cause real harm.</p>
  </section>`;

export const privacy = () => html`
  <h2 class="page-title">Privacy Policy</h2>
  <p class="aside">Last updated 2026-09-11. This is a hackathon demo — the text below is a plain description of what the app does, not reviewed legal advice.</p>
  <section class="block">
    <h3>What we collect</h3>
    <p>Nothing. There is no Verdikt server behind this page — it is a static site that reads Arc Testnet and Ethereum Sepolia over public RPC endpoints straight from your browser. No account, email or personal data is requested or stored by Verdikt.</p>
  </section>
  <section class="block">
    <h3>What's public by nature of the chain</h3>
    <p>Anything you do on-chain — registering a service, publishing an SLA, a payment, a verdict, a refund — is public, permanent blockchain data, visible to anyone, independent of this page. Connecting a wallet only reads the address it reports; that address is never sent anywhere by Verdikt.</p>
  </section>
  <section class="block">
    <h3>Local storage</h3>
    <p>Your theme preference and, if you sign in as a provider, a short-lived proof of address control (<a href="/how">how it works</a>) are kept in your browser's local storage. Neither ever leaves your device.</p>
  </section>`;

/** @param {(path: string) => void} go */
export const legalFooter = (go) => html`
  <footer class="legal">
    <a href="/terms" @click=${follow(go, '/terms')}>Terms</a>
    <a href="/privacy" @click=${follow(go, '/privacy')}>Privacy</a>
  </footer>`;
```

- [ ] **Step 4: Add CSS for the landing CTA, static-page title, and legal footer**

In `web/src/styles.css`, after the `footer { ... }` rule (the one styling the marketplace's stats footer), add:

```css
footer.legal { display: flex; gap: 16px; margin-top: 40px; }
footer.legal a { color: var(--muted); text-decoration: none; }
footer.legal a:hover { color: var(--ink); }
footer + footer.legal { margin-top: 12px; padding-top: 0; border-top: 0; }

.landing-cta { margin: 28px 0 0; }
.landing-cta wa-button::part(button) { font-size: 15px; padding-inline: 22px; }

.page-title { font: 700 34px/1.1 var(--display); margin: 8px 0 24px; letter-spacing: -0.02em; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run web/src/pages.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/pages.js web/src/pages.test.js web/src/styles.css
git commit -m "Add the landing page and static Terms/Privacy pages"
```

---

## Task 3: Split the marketplace's detail panel into its own page

**Files:**
- Modify: `web/src/provider.js` (rename a param, no logic change)
- Modify: `web/src/render.js` (test-helper route shape)
- Modify: `web/src/lit-app.js` (full rewrite)
- Modify: `web/src/marketplace.test.js` (the `rendering` describe block only)
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `parseRoute`'s route shape and `serviceUrl`/`providerUrl`/`MARKETPLACE_PATH`/`PROVIDER_PATH`/`HOW_PATH` from `./router.js` (Task 1); `TAGLINE`/`landing`/`terms`/`privacy`/`legalFooter` from `./pages.js` (Task 2).
- Produces: `VerdiktApp.go(path: string)` (replaces the old `navigate(view)`/`select(slug)` methods), dispatching a single `CustomEvent('navigate', { detail: path })` — this is what Task 4's `main.js` listens for. `resolveProviderConsole(services, view, routeAddress, account)` (renamed 3rd param, same behavior). `renderApp(marketplace, mode, view, selectedSlug, address)` in `render.js` (renamed 5th param, same behavior).

- [ ] **Step 1: Update the `rendering` describe block in `web/src/marketplace.test.js`**

Replace this block (the one starting `describe('rendering', () => {` and its three `it`s):

```js
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
    const html = renderApp(await build(), 'demo', 'marketplace', 'weather');
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
```

with:

```js
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

  it('renders a standalone service page without a DOM', async () => {
    const html = renderApp(await build(), 'demo', 'service', 'weather');
    expect(html).toContain('responds-within-5s');
    expect(html).toContain('back to the marketplace');
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
```

(The `'the provider view'` describe block below it, and every other block in the file, is unchanged — its `renderApp(..., 'provider', null, '0xA11ce...')` calls already pass `null` for the slug and the address as the 5th arg, which is exactly the renamed-but-same-shape parameter.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run web/src/marketplace.test.js`
Expected: FAIL — `renderApp(..., 'service', 'weather')` doesn't render a service page yet, and the old `renderApp(..., 'marketplace', 'weather')` split-screen behavior is gone from the test but not yet from the app.

- [ ] **Step 3: Update `web/src/provider.js`**

```js
/**
 * Resolves the provider console from a shareable address or the connected
 * wallet, and narrows the marketplace to services owned by that address.
 *
 * @param {Listing[]} services
 * @param {'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy'} view
 * @param {string|null} routeAddress
 * @param {string|null} account
 */
export function resolveProviderConsole(services, view, routeAddress, account) {
  const effectiveProvider = routeAddress ?? (view === 'provider' ? account : null);
  const owned = effectiveProvider
    ? services.filter((listing) => listing.provider.toLowerCase() === effectiveProvider.toLowerCase())
    : [];
  return { effectiveProvider, owned, target: owned[0] ?? null };
}
```

- [ ] **Step 4: Update `web/src/render.js`**

```js
// Server-side adapters for the existing DOM-free rendering tests. Production
// rendering is owned by <verdikt-app>; these wrappers serialize the same Lit
// templates so content and escaping remain directly testable in Node.

import { render as renderToIterable } from '@lit-labs/ssr';
import { detailTemplate, VerdiktApp } from './lit-app.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('');

/** @param {Listing} listing */
export function renderDetail(listing) {
  return stringify(detailTemplate(listing));
}

/**
 * @param {Marketplace} marketplace
 * @param {'live'|'demo'} mode
 * @param {'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy'} view
 * @param {string|null} selectedSlug
 * @param {string|null} [address]
 */
export function renderApp(marketplace, mode, view, selectedSlug, address = null) {
  const app = new VerdiktApp();
  app.marketplace = marketplace;
  app.mode = mode;
  app.route = { view, slug: selectedSlug, address };
  return stringify(app.render());
}

export { resolveProviderConsole } from './provider.js';
```

- [ ] **Step 5: Replace `web/src/lit-app.js` in full**

```js
import { LitElement, html, nothing } from 'lit';
import { formatMinorUsdc, formatNativeUsdc, formatScore, formatWhen, scoreBand, shortHex } from './format.js';
import { getConnectedAccount } from './wallet.js';
import { getSession } from './session.js';
import { ARC, SEPOLIA } from '@verdikt/sdk';
import { resolveProviderConsole } from './provider.js';
import { HOW_PATH, MARKETPLACE_PATH, PROVIDER_PATH, providerUrl, serviceUrl } from './router.js';
import { TAGLINE, landing, legalFooter, privacy, terms } from './pages.js';

const GITHUB_URL = 'https://github.com/imajus/verdikt';
const X_URL = 'https://x.com/verdict402';

/** @param {(path: string) => void} go @param {string} path */
const link = (go, path) => (/** @type {Event} */ event) => { event.preventDefault(); go(path); };

/** @param {(path: string) => void} go */
const brand = (go) => html`<h1><a class="brand" href="/" aria-label="Verdikt home" @click=${link(go, '/')}><img class="brand-mark" src="/favicon.svg" alt="" width="42" height="42" /><span>Verdikt</span></a></h1>`;
const githubIcon = () => html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg>`;
const xIcon = () => html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M9.53 6.78 15.17.5h-1.34L8.94 5.87 5.02.5H0l5.92 8.15L0 15.5h1.34l5.19-5.7 4.15 5.7H16L9.53 6.78Zm-1.84 2.02-.6-.83L2.3 1.44h2.06l3.84 5.29.6.83 4.99 6.87h-2.06L7.69 8.8Z"></path></svg>`;

/** @param {string} value */
const amount = (value) => {
  const [number, unit] = value.split(' ');
  return html`${number}${unit ? html` <small>${unit}</small>` : nothing}`;
};

/** @param {number|null} score */
const scoreCell = (score) => html`
  <span class="score ${scoreBand(score)}">
    <b>${formatScore(score)}</b>
    ${score === null ? nothing : html`<span class="meter"><span style="width:${score / 10}%"></span></span>`}
  </span>`;

/** @param {ServiceStatus} status */
const statusMark = (status) => html`
  <span class="state ${status.toLowerCase()}"><i class="dot"></i>${status.charAt(0)}${status.slice(1).toLowerCase()}</span>`;

/** @param {SlaOutcome} outcome */
const outcomeMark = (outcome) => html`
  <span class="outcome ${outcome.toLowerCase()}"><i class="dot"></i>${outcome}</span>`;

const listingHead = () => html`
  <div class="row head">
    <span class="cell name">Service</span>
    <span class="cell num" title="Share of responses that arrived and met the SLA">Conformance</span>
    <span class="cell num" title="Share of paid calls that returned anything usable">Availability</span>
    <span class="cell num">Bond</span>
    <span class="cell status">Status</span>
  </div>`;

/** @param {SlaClause} clause */
const clauseBound = (clause) =>
  clause.type === 'latency'
    ? `within ${clause.maxMs} ms`
    : clause.type === 'priceRange'
      ? `${formatMinorUsdc(BigInt(clause.minMinorUnits))} to ${formatMinorUsdc(BigInt(clause.maxMinorUnits))}`
      : 'matches the published shape';

/** @param {ListingVerdict} verdict */
const failedClauseCell = (verdict) => {
  if (verdict.outcome === 'PASS') return html`<span class="muted">—</span>`;
  if (verdict.failedClauseId === null) return html`<span class="muted" title="Judged on status alone: no SLA was in force for this call, so no clause was evaluated.">status only</span>`;
  if (verdict.failedClauseId === 'delivery') return html`<code title="The implicit clause every service is held to: a response arrived and was not a 5xx. No provider declares it.">delivery</code>`;
  if (verdict.failedClauseId === 'unknown') return html`<span class="warn" title="This verdict names a clause the published SLA no longer declares — it has been edited since.">edited since</span>`;
  return html`<code>${verdict.failedClauseId}</code>`;
};

/** @param {Listing} listing @param {(path: string) => void} go */
const listingRow = (listing, go) => {
  const unranked = listing.published.conformance === null && listing.published.availability === null;
  const href = serviceUrl(listing.slug);
  return html`
    <a class="row" href=${href} data-slug=${listing.slug} @click=${link(go, href)}>
      <span class="cell name">
        <strong>${listing.slug}</strong><small>${listing.name}</small>
        ${listing.contested ? html`<span class="contested">contested</span>` : nothing}
        ${unranked ? html`<span class="unranked">not yet ranked</span>` : nothing}
      </span>
      <span class="cell num">${scoreCell(listing.published.conformance)}</span>
      <span class="cell num">${scoreCell(listing.published.availability)}</span>
      <span class="cell num">${amount(formatNativeUsdc(listing.deposit, 2))}</span>
      <span class="cell status">${statusMark(listing.status)}</span>
    </a>`;
};

/** @param {Listing|null} listing */
export const detailTemplate = (listing) => {
  if (!listing) return html`<p class="empty">Pick a service to see what it promised and what it delivered.</p>`;
  const clauses = listing.sla?.clauses ?? [];
  const unpublished = listing.published.conformance === null;
  return html`
    <header class="detail-head">
      <div><h2>${listing.slug}</h2><p class="sub"><code>${listing.name}</code> ${statusMark(listing.status)}</p></div>
      <dl class="scores">
        <div><dt>Conformance</dt><dd>${scoreCell(listing.published.conformance)}</dd></div>
        <div><dt>Availability</dt><dd>${scoreCell(listing.published.availability)}</dd></div>
        <div><dt>Bond</dt><dd>${amount(formatNativeUsdc(listing.deposit, 2))}</dd></div>
      </dl>
    </header>
    ${unpublished ? html`<p class="aside">No scores published yet — the hourly run has not written this subname. Over the verdicts below the same computation gives ${formatScore(listing.unpublished.conformance)} conformance and ${formatScore(listing.unpublished.availability)} availability, but the marketplace ranks on what is published, not on this.</p>` : nothing}
    ${listing.namingLayer === 'unreachable' ? html`<p class="aside warn">The naming layer did not answer, so this service’s SLA and scores could not be read. Its bond and verdict history are on Arc and are shown.</p>` : nothing}
    ${listing.contested ? html`<p class="aside warn">This slug's ENS subname and its Arc registration are owned by different addresses. The proxy refuses to route it until they agree — see <a href="/how">how it works</a>.</p>` : nothing}
    <section class="block">
      <h3>Endpoint</h3>
      <table class="kv">
        <tr><th>Call</th><td><code>${listing.slug}.verdikt.bond/…</code></td></tr>
        <tr><th>Relays to</th><td><code>${listing.endpoint ?? 'no url record published'}</code></td></tr>
        <tr><th>Pays to</th><td><code>${listing.payTo ?? 'no address record published'}</code></td></tr>
        <tr><th>Provider</th><td><code>${listing.provider}</code></td></tr>
      </table>
    </section>
    <section class="block">
      <h3>What it promised <small>${clauses.length ? `${clauses.length} clause${clauses.length === 1 ? '' : 's'}` : ''}</small></h3>
      ${clauses.length === 0
        ? html`<p class="aside">${listing.slaRaw ? 'The published SLA does not parse, so every call falls back to status-only judging: 2xx passes, 5xx fails, anything else writes no verdict.' : 'No SLA published. Every call falls back to status-only judging.'}</p>`
        : html`<div class="scroll"><table class="clauses"><thead><tr><th>Clause</th><th>Type</th><th>Bound</th><th>Note</th></tr></thead><tbody>${clauses.map((clause) => html`<tr><td><code>${clause.id}</code></td><td>${clause.type}</td><td>${clauseBound(clause)}</td><td class="desc">${/** @type {{description?: string}} */ (clause).description ?? ''}</td></tr>`)}</tbody></table></div>`}
    </section>
    <section class="block">
      <h3>What it delivered <small>${listing.history.length} verdict${listing.history.length === 1 ? '' : 's'}</small></h3>
      ${listing.history.length === 0
        ? html`<p class="aside">No paid calls yet. A service nobody has called is presumed healthy — that is why it scores 1000 rather than 0.</p>`
        : html`
          <div class="strip" aria-hidden="true">${[...listing.history].reverse().map((verdict) => html`<i class=${verdict.outcome.toLowerCase()} title=${`${verdict.outcome}${verdict.blockNumber === null ? '' : ` · block ${verdict.blockNumber}`}`}></i>`)}</div>
          <div class="scroll"><table class="ledger"><thead><tr><th>Outcome</th><th>Broke</th><th>Request</th><th>Payer</th><th class="num">Paid</th><th class="num">Refunded</th><th class="num">Block</th></tr></thead><tbody>
            ${listing.history.map((verdict) => html`<tr class="verdict ${verdict.outcome.toLowerCase()}"><td>${outcomeMark(verdict.outcome)}</td><td>${failedClauseCell(verdict)}</td><td><code title=${verdict.requestId}>${shortHex(verdict.requestId)}</code></td><td><code title=${verdict.payer}>${shortHex(verdict.payer)}</code></td><td class="num">${formatMinorUsdc(verdict.paidAmount)}</td><td class="num">${verdict.refunded > 0n ? formatNativeUsdc(verdict.refunded, 2) : html`<span class="muted">—</span>`}</td><td class="num muted">${verdict.blockNumber ?? '—'}</td></tr>`)}
          </tbody></table></div>
          <p class="aside">A FAIL or DOWN credits the payer from this service’s bond, capped at what they actually paid. The credit is booked, not sent — the agent calls <code>withdraw()</code> to collect.</p>`}
    </section>`;
};

/** @param {'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy'} view @param {'live'|'demo'} mode @param {'light'|'dark'} theme @param {string|null} account @param {(path: string) => void} go @param {() => void} connect @param {() => void} disconnect @param {(theme: 'light'|'dark') => void} changeTheme */
const nav = (view, mode, theme, account, go, connect, disconnect, changeTheme) => {
  /** @param {string} path @param {string} label @param {string} activeView */
  const item = (path, label, activeView) => {
    const active = view === activeView || (activeView === 'marketplace' && view === 'service');
    return html`<a href=${path} class="nav-item ${active ? 'active' : ''}" data-nav=${activeView} @click=${link(go, path)}>${label}</a>`;
  };
  /** @param {'light'|'dark'} value @param {string} label */
  const themeButton = (value, label) => html`<wa-button class="theme-button ${theme === value ? 'selected' : ''}" appearance="outlined" size="xs" aria-pressed=${String(theme === value)} @click=${() => changeTheme(value)}>${label}</wa-button>`;
  /** @param {CustomEvent<{ item: { value: string } }>} event */
  const selectWalletAction = (event) => {
    if (event.detail.item.value === 'change') connect();
    if (event.detail.item.value === 'disconnect') disconnect();
  };
  const wallet = mode === 'live'
    ? account
      ? html`<wa-dropdown class="wallet-menu" placement="bottom-end" size="s" @wa-select=${selectWalletAction}>
          <wa-button slot="trigger" class="nav-account" appearance="outlined" size="s" with-caret title=${account} aria-label="Wallet menu for ${account}">${account.slice(0, 6)}…${account.slice(-4)}</wa-button>
          <div class="wallet-menu-heading"><span>Connected wallet</span><code>${account}</code></div>
          <wa-divider></wa-divider>
          <wa-dropdown-item value="change"><svg slot="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/></svg>Change wallet</wa-dropdown-item>
          <wa-dropdown-item value="disconnect" variant="danger"><svg slot="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9 4H4v16h5m5-13 5 5-5 5M9 12h10"/></svg>Disconnect</wa-dropdown-item>
        </wa-dropdown>`
      : html`<wa-button type="button" appearance="outlined" size="s" @click=${connect}>Connect wallet</wa-button>`
    : nothing;
  return html`<nav class="nav"><div class="nav-links">${item(MARKETPLACE_PATH, 'Marketplace', 'marketplace')}${mode === 'live' ? item(PROVIDER_PATH, 'Provider', 'provider') : nothing}${item(HOW_PATH, 'How it works', 'how')}</div><div class="nav-external"><wa-button-group class="theme-control" label="Color theme">${themeButton('light', 'Light')}${themeButton('dark', 'Dark')}</wa-button-group><a href=${GITHUB_URL} target="_blank" rel="noopener noreferrer" aria-label="Verdikt on GitHub">${githubIcon()}</a><a href=${X_URL} target="_blank" rel="noopener noreferrer" aria-label="Verdikt on X">${xIcon()}</a>${wallet}</div></nav>`;
};

/** @param {string} width */
const bar = (width) => html`<span class="bar" style="width:${width}"></span>`;

/** @param {string} label */
const skeletonFigure = (label) => html`<div class="figure skeleton"><span class="value">${bar('3.5rem')}</span><span class="label">${label}</span></div>`;

/** @param {string} nameWidth */
const skeletonRow = (nameWidth) => html`
  <div class="row skeleton">
    <span class="cell name">${bar(nameWidth)}</span>
    <span class="cell num">${bar('2.2rem')}</span>
    <span class="cell num">${bar('2.2rem')}</span>
    <span class="cell num">${bar('2.6rem')}</span>
    <span class="cell status">${bar('3rem')}</span>
  </div>`;

const SKELETON_ROW_WIDTHS = ['72%', '58%', '85%', '64%', '50%', '78%'];

// Shaped like renderMarketplace(), not a generic spinner: the same masthead,
// figures and listing grid the real page fills in, so nothing shifts when the
// data arrives. Redacted rather than shimmered, to match the ledger's own
// vocabulary of hairline rules and monospace rather than boxed cards.
/** @param {(path: string) => void} go */
const skeleton = (go) => html`
  <div aria-hidden="true">
    <header class="masthead"><div>${brand(go)}<p class="tagline">${TAGLINE}</p></div></header>
    <section class="figures">${['services', 'bonded', 'verdicts', 'refunded'].map(skeletonFigure)}</section>
    <section class="listing">${listingHead()}${SKELETON_ROW_WIDTHS.map(skeletonRow)}</section>
  </div>
  <p class="visually-hidden" role="status">Loading the marketplace…</p>`;

/** @param {(path: string) => void} go */
const how = (go) => html`
  <header class="masthead"><div>${brand(go)}<p class="tagline">How the verification loop works, end to end.</p></div></header>
  <section class="block"><h3>Two chains, each for one reason</h3><p><strong>Arc</strong> holds the registry, the escrow, the verdicts and the refunds — and the x402 payment itself. USDC is Arc's native gas token, so value moves as <code>msg.value</code>, not an ERC-20 transfer: no <code>approve</code>/<code>transferFrom</code>, no token address. Payment, bond and refund are the same asset on the same chain, which removes any cross-chain correlation between payment and refund.</p><p><strong>Ethereum Sepolia</strong> holds ENS. The SLA lives only as the <code>sla</code> text record on <code>&lt;slug&gt;.verdikt.eth</code>. A per-key access list scopes the provider to <code>sla</code> and <code>url</code>, and the CRE signer to <code>conformance</code> and <code>availability</code>.</p></section>
  <section class="block"><h3>What happens on a paid call</h3><p>A proxy sits between the paying agent and the provider's x402 endpoint. Without a payment header, it checks that the challenge's payout address matches ENS. With payment attached, the call is replayed inside a Chainlink CRE Confidential Workflow and evaluated against the provider's published SLA without exposing the raw response outside the enclave.</p><p>The workflow writes PASS, FAIL or DOWN on Arc. A FAIL or DOWN credits the payer from the service's bond, capped at <code>min(fixed refund, what was actually paid, what remains of the bond)</code>.</p></section>
  <section class="block"><h3>Why there is no dispute layer</h3><p>A verdict is final by design. The refund cap keeps a false FAIL from being worth manufacturing, and the observed value never goes on-chain. The clause, refund and trailing seven-day scores remain public on Arc and ENS.</p></section>`;

export class VerdiktApp extends LitElement {
  static properties = { marketplace: { attribute: false }, mode: {}, route: { attribute: false }, error: {}, theme: {}, signInPending: { state: true }, signInError: { state: true } };
  constructor() {
    super();
    this.signInPending = false;
    /** @type {string|null} */ this.signInError = null;
    /** @type {Marketplace|null} */ this.marketplace = null;
    /** @type {'live'|'demo'} */ this.mode = 'demo';
    /** @type {string|null} */ this.error = null;
    /** @type {'light'|'dark'} */ this.theme = 'light';
    /** @type {{view: 'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy', slug: string|null, address: string|null}} */
    this.route = { view: 'landing', slug: null, address: null };
  }
  createRenderRoot() { return this; }
  /** @param {string} path */
  go(path) { this.dispatchEvent(new CustomEvent('navigate', { detail: path })); }
  connect() { this.dispatchEvent(new CustomEvent('wallet-connect')); }
  disconnect() { this.dispatchEvent(new CustomEvent('wallet-disconnect')); }
  signIn() { this.dispatchEvent(new CustomEvent('provider-sign-in')); }
  /** @param {'light'|'dark'} theme */
  changeTheme(theme) { this.dispatchEvent(new CustomEvent('theme-select', { detail: theme })); }
  /** @param {Listing[]} owned @param {string} provider @param {(path: string) => void} go */
  renderProvider(owned, provider, go) {
    const account = getConnectedAccount();
    const ownPage = account?.address.toLowerCase() === provider.toLowerCase();
    const supported = account && [ARC.chainId, SEPOLIA.chainId].includes(account.chainId);
    const signedIn = ownPage && getSession()?.address.toLowerCase() === account?.address.toLowerCase();
    const bonded = owned.reduce((total, listing) => total + listing.deposit, 0n);
    const refunded = owned.reduce((total, listing) => total + listing.history.reduce((sum, verdict) => sum + verdict.refunded, 0n), 0n);
    const verdicts = owned.reduce((total, listing) => total + listing.history.length, 0);
    const target = owned[0] ?? null;
    return html`<header class="masthead"><div>${brand(go)}<p class="tagline">Provider <code>${provider}</code> · <a href=${MARKETPLACE_PATH} @click=${link(go, MARKETPLACE_PATH)}>back to the marketplace</a></p></div><p class="source">${owned.length} service${owned.length === 1 ? '' : 's'}</p></header>
      ${ownPage && (!signedIn || !supported) ? html`<div class="aside"><p>${signedIn ? 'Switch to a supported network to manage your services.' : 'Sign in once to manage your services. Your sign-in lasts 24 hours in this browser.'}</p><wa-button size="s" appearance="outlined" ?disabled=${this.signInPending} ?loading=${this.signInPending} @click=${this.signIn}>${signedIn ? 'Switch network' : 'Enable provider actions'}</wa-button>${this.signInError ? html`<p role="status">${this.signInError}</p>` : nothing}</div>` : nothing}
      <section class="block"><h3>Add a service</h3><verdikt-wizard id="wizard-mount"></verdikt-wizard></section>
      <section class="figures"><div class="figure"><span class="value">${owned.length}</span><span class="label">services</span></div><div class="figure"><span class="value">${amount(formatNativeUsdc(bonded, 2))}</span><span class="label">bonded</span></div><div class="figure"><span class="value ${refunded > 0n ? 'fail' : ''}">${amount(formatNativeUsdc(refunded, 2))}</span><span class="label">refunded from your bonds</span></div><div class="figure"><span class="value">${verdicts}</span><span class="label">verdicts</span></div></section>
      ${owned.length === 0 ? html`<p class="empty">No services registered by this address.</p>` : html`<div class="layout"><section class="listing">${listingHead()}${owned.map((listing) => listingRow(listing, go))}</section><section class="detail">${detailTemplate(target)}</section></div>`}
      ${target ? html`
        <section class="editor block"><h3>SLA editor <small>${target.name}</small></h3><p class="aside">Validated against the same <code>schema.json</code> the verifier enforces. Sent from your own wallet; Verdikt holds no key of yours.</p><verdikt-sla-editor id="sla-editor-mount"></verdikt-sla-editor></section>
        <section class="block"><h3>Bond <small>${target.name}</small></h3><verdikt-bond-controls id="bond-controls-mount"></verdikt-bond-controls></section>` : nothing}`;
  }
  /** @param {PlatformStats} stats @param {Listing[]} services @param {(path: string) => void} go */
  renderMarketplace(stats, services, go) {
    const { PASS, FAIL, DOWN } = stats.breakdown;
    return html`<header class="masthead"><div>${brand(go)}<p class="tagline">${TAGLINE}</p></div><p class="source ${this.mode}"><i class="dot"></i>${this.mode === 'demo' ? 'demo data' : 'Arc Testnet'}</p></header>
      ${this.mode === 'demo' ? html`<p class="aside warn">Showing seeded data, not a live chain. Set <code>VITE_ARC_RPC_URL</code> to read Arc directly.</p>` : nothing}
      <section class="figures"><div class="figure"><span class="value">${stats.services}</span><span class="label">services</span><span class="sub"><span>${stats.active} active</span>${stats.suspended ? html`<span>${stats.suspended} suspended</span>` : nothing}</span></div><div class="figure"><span class="value">${amount(formatNativeUsdc(stats.bonded, 2))}</span><span class="label">bonded</span></div><div class="figure"><span class="value">${stats.verdicts}</span><span class="label">verdicts</span>${stats.verdicts ? html`<div class="breakdown">${PASS ? html`<span class="seg pass" style="flex-grow:${PASS}"></span>` : nothing}${FAIL ? html`<span class="seg fail" style="flex-grow:${FAIL}"></span>` : nothing}${DOWN ? html`<span class="seg down" style="flex-grow:${DOWN}"></span>` : nothing}</div><span class="sub"><span class="pass"><i class="dot"></i>${PASS} pass</span><span class="fail"><i class="dot"></i>${FAIL} fail</span><span class="down"><i class="dot"></i>${DOWN} down</span></span>` : nothing}</div><div class="figure"><span class="value">${amount(formatNativeUsdc(stats.refunded, 2))}</span><span class="label">refunded</span><span class="sub"><span>${stats.refundCount} refund${stats.refundCount === 1 ? '' : 's'}</span></span></div></section>
      <section class="listing">${listingHead()}${services.length ? services.map((listing) => listingRow(listing, go)) : html`<p class="empty">No services registered yet.</p>`}</section>
      <footer>Scores are the trailing ${Math.round(stats.windowSeconds / 86400)}-day ratios published on <code>&lt;slug&gt;.verdikt.eth</code>, recomputed hourly. Per-call verdicts are Arc events. A verdict is final: there is no dispute layer, by design. As of ${formatWhen(Math.floor(Date.now() / 1000))} UTC${services.length ? html` · <a href=${providerUrl(services[0].provider)} @click=${link(go, providerUrl(services[0].provider))}>provider view</a>` : nothing}</footer>`;
  }
  /** @param {Listing[]} services @param {string} slug @param {(path: string) => void} go */
  renderService(services, slug, go) {
    const listing = services.find((service) => service.slug === slug) ?? null;
    const back = html`<p class="back"><a href=${MARKETPLACE_PATH} @click=${link(go, MARKETPLACE_PATH)}>← back to the marketplace</a></p>`;
    if (!listing) return html`${back}<p class="empty">No service found for “${slug}”.</p>`;
    return html`${back}${detailTemplate(listing)}`;
  }
  render() {
    if (this.error) return html`<p class="note warn">Could not load the marketplace: ${this.error}</p>`;
    /** @type {(path: string) => void} */
    const go = (path) => this.go(path);
    const account = getConnectedAccount()?.address ?? null;
    const navBar = nav(this.route.view, this.mode, this.theme, account, go, () => this.connect(), () => this.disconnect(), (theme) => this.changeTheme(theme));
    if (this.route.view === 'landing') return html`${navBar}${landing(go)}${legalFooter(go)}`;
    if (this.route.view === 'terms') return html`${navBar}${terms()}${legalFooter(go)}`;
    if (this.route.view === 'privacy') return html`${navBar}${privacy()}${legalFooter(go)}`;
    if (!this.marketplace) return html`${navBar}${skeleton(go)}`;
    const { services, stats } = this.marketplace;
    const body = this.route.view === 'how'
      ? how(go)
      : this.route.view === 'service'
        ? this.renderService(services, /** @type {string} */ (this.route.slug), go)
        : (() => {
            const { effectiveProvider, owned } = resolveProviderConsole(services, this.route.view, this.route.address, account);
            return effectiveProvider ? this.renderProvider(owned, effectiveProvider, go) : this.renderMarketplace(stats, services, go);
          })();
    return html`${navBar}${body}${legalFooter(go)}`;
  }
}

if (!customElements.get('verdikt-app')) customElements.define('verdikt-app', VerdiktApp);
```

- [ ] **Step 6: Update `web/src/styles.css` for the new anchor-based rows and back link**

Replace:

```css
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 5.4rem 5.4rem 5.4rem 5.8rem;
  gap: 10px; align-items: center; width: 100%; text-align: left;
  padding: 13px 10px 13px 14px; background: none; border: 0; border-bottom: 1px solid var(--rule);
  color: inherit; font: inherit; cursor: pointer; position: relative;
}
.row.head { cursor: default; padding: 8px 10px 8px 14px; font-size: 12.5px; color: var(--muted); }
.row:not(.head):hover { background: var(--paper-2); }
.row.selected { background: var(--paper-2); }
.row.selected::before {
  content: ""; position: absolute; left: 0; top: -1px; bottom: -1px; width: 3px;
  background: var(--ink);
}
```

with:

```css
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 5.4rem 5.4rem 5.4rem 5.8rem;
  gap: 10px; align-items: center; width: 100%; text-align: left;
  padding: 13px 10px 13px 14px; background: none; border: 0; border-bottom: 1px solid var(--rule);
  color: inherit; font: inherit; text-decoration: none; cursor: pointer; position: relative;
}
.row.head { cursor: default; padding: 8px 10px 8px 14px; font-size: 12.5px; color: var(--muted); }
.row:not(.head):hover { background: var(--paper-2); }
```

(`.row.selected` and its `::before` marker are gone: no page keeps an embedded, currently-selected row anymore — clicking a row now navigates to that service's own page. `.layout`/`.detail`/`.listing { position: sticky }` are untouched, since the provider console still uses the two-column layout.)

Then, near the `.detail` rules, add:

```css
.back { margin: 0 0 18px; }
.back a { color: var(--link); text-decoration: none; }
.back a:hover { text-decoration: underline; }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run web/src/marketplace.test.js`
Expected: PASS

- [ ] **Step 8: Run the full web test suite to catch anything else touching the old shape**

Run: `pnpm vitest run web`
Expected: PASS for every file except `web/src/main.test.js`, which Task 4 updates next (it will currently still pass, since it mocks `./lit-app.js` entirely and doesn't yet exercise `history.pushState`/`window.addEventListener` — but confirm it does still pass before moving on).

- [ ] **Step 9: Commit**

```bash
git add web/src/provider.js web/src/render.js web/src/lit-app.js web/src/marketplace.test.js web/src/styles.css
git commit -m "Extract service detail into its own page"
```

---

## Task 4: Wire real navigation into main.js, redirect to the provider console on connect

**Files:**
- Modify: `web/src/main.js` (full rewrite)
- Modify: `web/src/main.test.js`

**Interfaces:**
- Consumes: `parseRoute`, `providerUrl`, `titleFor` from `./router.js` (Task 1); the `'navigate'` custom event from `VerdiktApp.go()` (Task 3); `route.address` (renamed from `route.provider`).
- Produces: nothing consumed elsewhere — `main.js` is the application's entry point.

- [ ] **Step 1: Update `web/src/main.test.js`'s global stubs and add two new tests**

In `beforeEach`, right after the existing `vi.stubGlobal('location', new URL(...))` line, add:

```js
  vi.stubGlobal('history', { replaceState: vi.fn(), pushState: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
```

At the end of the file, add two new tests:

```js
it('navigates to the provider console after an explicit wallet connect', async () => {
  await events.get('wallet-connect')?.(); await settle();
  expect(history.pushState).toHaveBeenCalledWith(null, '', `/provider/${OWNER}`);
});
it('does not navigate to the provider console on a silent wallet restoration', async () => {
  change(OTHER);
  await settle();
  expect(history.pushState).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify the new tests fail**

Run: `pnpm vitest run web/src/main.test.js`
Expected: FAIL — `history`/`window` aren't stubbed yet in the current file (this step both adds the stubs and the assertions in one edit; to see the two new assertions actually fail against the *old* `main.js`, temporarily confirm by running against HEAD's `main.js` before Step 3 — the old `wallet-connect` handler never calls `history.pushState`, so the first new test fails with "expected pushState to have been called").

- [ ] **Step 3: Replace `web/src/main.js` in full**

```js
import { ARC, SEPOLIA, registryAbi } from '@verdikt/sdk';
import { byReputation, loadMarketplace } from './marketplace.js';
import { formatNativeUsdc } from './format.js';
import { resolveProviderConsole } from './provider.js';
import { parseRoute, providerUrl, titleFor } from './router.js';
import { createSource } from './source.js';
import { connectWallet, disconnectWallet, ensureChain, getConnectedAccount, onAccountChange, restoreWallet, walletClientFor } from './wallet.js';
import { getSession, signIn } from './session.js';
import { savedTheme, saveTheme } from './theme.js';
// Import tokens only. Web Awesome's all-in-one stylesheet also styles every
// native button, table, and heading, which would override the ledger UI.
import '@awesome.me/webawesome/dist/styles/themes/default.css';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import './forms/sla-editor.js';
import './forms/bond.js';
import './forms/wizard.js';
import './lit-app.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
const app = /** @type {import('./lit-app.js').VerdiktApp} */ (document.createElement('verdikt-app'));
root.append(app);
app.theme = savedTheme();
const env = import.meta.env ?? {};
const { mode, deps } = createSource(env);
// Set before main() resolves, not just in draw(), so the nav's wallet button
// is present in the loading skeleton rather than appearing once data lands.
app.mode = mode;
// Same reasoning, for the route: a direct load of e.g. /marketplace must not
// flash the landing page's default route while loadMarketplace() is still
// in flight.
app.route = syncRoute();

const ARC_CHAIN_CONFIG = { chainId: ARC.chainId, name: 'Arc Testnet', rpcUrl: /** @type {string} */ (env.VITE_ARC_RPC_URL || 'https://rpc.testnet.arc.network'), nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 } };
const SEPOLIA_CHAIN_CONFIG = { chainId: SEPOLIA.chainId, name: 'Ethereum Sepolia', rpcUrl: /** @type {string} */ (env.VITE_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com') };

/** @type {Marketplace | null} */
let marketplaceCache = null;
/**
 * Only meaningful in live mode — demo mode's registry stub exposes no
 * .client/.address (web/src/source.js), and the Provider tab is hidden
 * there anyway, so nothing ever reads depositAmountCache in demo mode.
 * @type {bigint | null}
 */
let depositAmountCache = null;

/**
 * The one place the URL is read and, if it isn't canonical (a legacy
 * `?provider=` link, an old bookmark), rewritten. `parseRoute` (router.js)
 * decides what canonical means; this is the side-effecting caller its own
 * file comment describes.
 */
function syncRoute() {
  const url = new URL(location.href);
  const route = parseRoute(url);
  if (route.canonicalPath !== url.pathname + url.search) history.replaceState(null, '', route.canonicalPath);
  document.title = titleFor(route);
  return route;
}

async function main() {
  app.error = null;
  app.marketplace = null;
  try {
    marketplaceCache = await loadMarketplace(deps);
    marketplaceCache.services.sort(byReputation);
    if (mode === 'live') {
      depositAmountCache = await /** @type {any} */ (deps.registry).client.readContract({
        address: /** @type {any} */ (deps.registry).address,
        abi: registryAbi,
        functionName: 'DEPOSIT_AMOUNT'
      });
    }
    draw();
  } catch (error) {
    app.marketplace = null;
    app.error = /** @type {Error} */ (error).message;
  }
}

function draw() {
  if (!marketplaceCache) return;
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const route = syncRoute();
  // `verdikt-app` is patched asynchronously by Lit. Clear the currently
  // mounted controls before that patch removes them, otherwise a wallet that
  // owns no services can retain the prior provider's listing and dependencies.
  if (route.view === 'provider' && mode === 'live' && !resolveProviderConsole(marketplace.services, route.view, route.address, getConnectedAccount()?.address ?? null).target) {
    clearProviderControls(false);
  }
  app.mode = mode;
  app.theme = savedTheme();
  app.route = route;
  app.marketplace = marketplace;
  if (route.view === 'provider' && mode === 'live') {
    app.updateComplete.then(() => mountProviderConsole(route));
  }
}

function clearProviderControls(reset = true) {
  const wizard = /** @type {import('./forms/wizard.js').VerdiktWizard|null} */ (app.querySelector('#wizard-mount'));
  if (wizard) {
    wizard.deps = null;
    if (reset) wizard.clear();
  }
  const slaMount = /** @type {import('./forms/sla-editor.js').VerdiktSlaEditor|null} */ (app.querySelector('#sla-editor-mount'));
  const bondMount = /** @type {import('./forms/bond.js').VerdiktBondControls|null} */ (app.querySelector('#bond-controls-mount'));
  if (reset) { slaMount?.clear(); bondMount?.clear(); }
  else {
    if (slaMount) slaMount.deps = null;
    if (bondMount) bondMount.deps = null;
  }
}

/**
 * @param {ReturnType<typeof parseRoute>} route
 */
function mountProviderConsole(route) {
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const account = getConnectedAccount();
  const session = getSession();
  const { effectiveProvider, target } = resolveProviderConsole(marketplace.services, route.view, route.address, account?.address ?? null);
  const viewingOwnPage = Boolean(account && effectiveProvider && account.address.toLowerCase() === effectiveProvider.toLowerCase());
  const sessionMatchesAccount = Boolean(account && session && session.address.toLowerCase() === account.address.toLowerCase() && [ARC.chainId, SEPOLIA.chainId].includes(account.chainId));
  // Set in main() before draw() is ever called in live mode — see the guard
  // in main() above. Not null here.
  const depositAmount = /** @type {bigint} */ (depositAmountCache);
  const wizardMount = /** @type {import('./forms/wizard.js').VerdiktWizard|null} */ (app.querySelector('#wizard-mount'));
  if (wizardMount && account && sessionMatchesAccount && viewingOwnPage) {
    if (SEPOLIA.subnameRegistrar) {
      wizardMount.message = '';
      wizardMount.deps = {
        account: account.address,
        registrarAddress: SEPOLIA.subnameRegistrar,
        registryAddress: /** @type {string} */ (ARC.registry),
        depositAmount,
        sepoliaRpcUrl: SEPOLIA_CHAIN_CONFIG.rpcUrl,
        formatNativeUsdc,
        walletClientFor: (chain) => walletClientFor(chain === 'arc' ? ARC_CHAIN_CONFIG : SEPOLIA_CHAIN_CONFIG),
        ensureSepolia: () => ensureSignedChain(SEPOLIA_CHAIN_CONFIG),
        ensureArc: () => ensureSignedChain(ARC_CHAIN_CONFIG),
        onDone: () => main()
      };
    } else {
      wizardMount.message = 'Service onboarding needs the subname registrar deployed — not yet live on this build.';
    }
  } else if (wizardMount) {
    wizardMount.deps = null;
    wizardMount.message = viewingOwnPage ? 'Sign in with this wallet to add a service.' : account ? "Connect as this provider's own address to add a service." : 'Connect a wallet to add a service.';
  }
  const slaMount = /** @type {import('./forms/sla-editor.js').VerdiktSlaEditor|null} */ (app.querySelector('#sla-editor-mount'));
  const bondMount = /** @type {import('./forms/bond.js').VerdiktBondControls|null} */ (app.querySelector('#bond-controls-mount'));
  // Defensive duplicate of the pre-render reset in draw(). It keeps this
  // invariant true if this mounting sequence is called independently later.
  if (!target) {
    slaMount?.clear();
    bondMount?.clear();
    return;
  }
  if (slaMount && sessionMatchesAccount && viewingOwnPage) {
    slaMount.message = '';
    slaMount.listing = target;
    slaMount.deps = {
      walletClientFor: () => walletClientFor(SEPOLIA_CHAIN_CONFIG),
      ensureSepolia: () => ensureSignedChain(SEPOLIA_CHAIN_CONFIG)
    };
  } else if (slaMount) {
    slaMount.deps = null;
    slaMount.message = viewingOwnPage ? 'Sign in with this wallet to publish changes.' : "Connect as this service's own provider to publish changes.";
  }
  if (bondMount && sessionMatchesAccount && viewingOwnPage) {
    bondMount.message = '';
    bondMount.listing = target;
    bondMount.deps = {
      walletClientFor: () => walletClientFor(ARC_CHAIN_CONFIG),
      registryAddress: /** @type {string} */ (ARC.registry),
      depositAmount,
      formatNativeUsdc,
      ensureArc: () => ensureSignedChain(ARC_CHAIN_CONFIG)
    };
  } else if (bondMount) {
    bondMount.deps = null;
    bondMount.message = viewingOwnPage ? 'Sign in with this wallet to manage its bond.' : "Connect as this service's own provider to manage its bond.";
  }
}

onAccountChange((_address, identityChanged) => {
  clearProviderControls(identityChanged);
  draw();
});

async function signInConnected() {
  const account = getConnectedAccount();
  if (!account) throw new Error('connect a wallet first');
  if (getSession()?.address.toLowerCase() === account.address.toLowerCase()) return;
  const config = account.chainId === ARC.chainId ? ARC_CHAIN_CONFIG : SEPOLIA_CHAIN_CONFIG;
  await signIn(account.chainId, {
    address: account.address,
    walletClient: /** @type {any} */ (walletClientFor(config)),
    domain: location.host,
    origin: location.origin,
    isCurrent: () => getConnectedAccount() === account
  });
}

/** @param {typeof ARC_CHAIN_CONFIG | typeof SEPOLIA_CHAIN_CONFIG} config */
async function ensureSignedChain(config) {
  await ensureChain(config.chainId, config);
  await signInConnected();
  draw();
  // Restore dependencies suspended by the chain-change event before the
  // pending provider action resumes, preserving its draft and wizard step.
  mountProviderConsole(parseRoute(new URL(location.href)));
}
app.addEventListener('wallet-disconnect', async () => {
  try { await disconnectWallet(); }
  catch (error) { console.error('disconnect failed:', error); }
});
app.addEventListener('navigate', (event) => {
  const path = /** @type {CustomEvent<string>} */ (event).detail;
  if (path !== location.pathname + location.search) history.pushState(null, '', path);
  draw();
});
app.addEventListener('theme-select', (event) => {
  saveTheme(/** @type {CustomEvent<'light'|'dark'>} */ (event).detail);
  app.theme = savedTheme();
});
app.addEventListener('wallet-connect', async () => {
  try {
    const account = await connectWallet();
    // Connecting a wallet in this dashboard has no purpose today other than
    // provider self-management, so an explicit connect always lands there —
    // unlike the silent auto-reconnect below, which never fires this handler.
    history.pushState(null, '', providerUrl(account.address));
    draw();
  } catch (error) {
    console.error('connection failed:', /** @type {Error} */ (error).message);
  }
});
app.addEventListener('provider-sign-in', async () => {
  if (app.signInPending) return;
  app.signInPending = true;
  app.signInError = null;
  try {
    const account = getConnectedAccount();
    const route = parseRoute(new URL(location.href));
    if (!account || (route.address && route.address.toLowerCase() !== account.address.toLowerCase())) throw new Error('Connect your provider wallet first.');
    if (account && ![ARC.chainId, SEPOLIA.chainId].includes(account.chainId)) {
      await ensureChain(SEPOLIA.chainId, SEPOLIA_CHAIN_CONFIG);
    }
    await signInConnected();
    draw();
  } catch {
    app.signInError = 'Sign-in was not completed. You can try again when you’re ready.';
  } finally {
    app.signInPending = false;
  }
});

window.addEventListener('popstate', () => draw());

main();
if (mode === 'live') {
  restoreWallet().catch(error => console.warn('wallet restoration failed:', error));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run web/src/main.test.js`
Expected: PASS

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm vitest run web`
Expected: PASS across every `web/src/**/*.test.js` file.

- [ ] **Step 6: Commit**

```bash
git add web/src/main.js web/src/main.test.js
git commit -m "Route navigation through history and redirect to the provider console on connect"
```

---

## Task 5: SPA fallback for both deploy targets

**Files:**
- Modify: `web/wrangler.jsonc`
- Modify: `web/Dockerfile`
- Create: `web/nginx.conf`

**Interfaces:**
- Consumes: nothing (infra-only).
- Produces: nothing consumed by app code — this is what makes a hard refresh on `/marketplace`, `/services/:slug`, `/provider/:address`, `/terms`, `/privacy` work on both deploy targets instead of 404ing, since neither the Workers-assets deploy nor the nginx/Docker deploy has a server that otherwise knows about these paths.

- [ ] **Step 1: Add the Cloudflare Workers assets SPA fallback**

In `web/wrangler.jsonc`, change:

```jsonc
  "assets": {
    "directory": "./dist"
  }
```

to:

```jsonc
  "assets": {
    "directory": "./dist",
    // Real paths (see web/src/router.js) need any unmatched request to
    // resolve to index.html — otherwise a hard refresh on e.g. /marketplace
    // 404s instead of letting the client-side router take over.
    "not_found_handling": "single-page-application"
  }
```

- [ ] **Step 2: Create `web/nginx.conf`**

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

- [ ] **Step 3: Wire the config into `web/Dockerfile`**

Change:

```dockerfile
FROM nginx:1.27-alpine AS serve
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
```

to:

```dockerfile
FROM nginx:1.27-alpine AS serve
COPY --from=build /app/web/dist /usr/share/nginx/html
# Real paths (web/src/router.js) need an unmatched request to fall back to
# index.html — nginx's default config has no such rule.
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 4: Verify the build still succeeds and the fallback file is in place**

Run: `pnpm --filter @verdikt/web build`
Expected: builds `web/dist/` exactly as before (this task changes no application code, only deploy config, so the build output is unaffected).

Run: `grep -n "not_found_handling" web/wrangler.jsonc`
Expected: prints the line added in Step 1.

Run: `grep -n "try_files" web/nginx.conf`
Expected: prints the line added in Step 2.

(A full `docker build`/`wrangler dev` smoke test of the fallback is a manual, non-automated check — reasonable to skip here since neither tool runs in this environment's test suite; note it as a follow-up manual check before the next real deploy.)

- [ ] **Step 5: Commit**

```bash
git add web/wrangler.jsonc web/Dockerfile web/nginx.conf
git commit -m "Add an SPA fallback to both deploy targets for real dashboard paths"
```

---

## Final verification

- [ ] Run `pnpm lint` — expect no new errors from `web/`.
- [ ] Run `pnpm typecheck` — expect no new errors from `web/`.
- [ ] Run `pnpm vitest run web` — expect every test in `web/src/**/*.test.js` to pass.
- [ ] Manually smoke-test with `pnpm --filter @verdikt/web dev` (or the `run-web` skill): visit `/`, click through to `/marketplace`, click a listing row into `/services/:slug` and back, visit `/terms` and `/privacy` via the footer, connect a wallet and confirm it lands on `/provider/<address>`, and hit refresh on each of those URLs to confirm none 404 in Vite's dev server (which already falls back to `index.html` by default).
