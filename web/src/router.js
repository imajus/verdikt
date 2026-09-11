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
