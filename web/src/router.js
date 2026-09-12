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
//
// An address is validated here and nowhere else: past parseRoute, `address`
// is either a real address or null, and null means no provider is selected
// at all. The connected wallet never fills that gap — routing decides whose
// console this is, authorization only decides what renders on it
// (docs/superpowers/specs/2026-09-11-provider-route-authorization-design.md).

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const LANDING_PATH = '/';
export const MARKETPLACE_PATH = '/marketplace';
export const PROVIDER_PATH = '/provider';
export const HOW_PATH = '/how';
export const TERMS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';
export const REGISTER_PATH = '/register';
export const WITHDRAW_PATH = '/withdraw';

const STATIC_VIEWS = /** @type {Record<string, string>} */ ({
  '/': 'landing',
  [MARKETPLACE_PATH]: 'marketplace',
  [HOW_PATH]: 'how',
  [TERMS_PATH]: 'terms',
  [PRIVACY_PATH]: 'privacy',
  [REGISTER_PATH]: 'register',
  [WITHDRAW_PATH]: 'withdraw'
});

/** @param {string} slug */
export function serviceUrl(slug) {
  return `/services/${encodeURIComponent(slug)}`;
}

/** The owner's console for one service: SLA and bond. Public, like the service page; what renders on it is authorization's call. */
export function manageUrl(/** @type {string} */ slug) {
  return `${serviceUrl(slug)}/manage`;
}

/** @param {string} address */
export function providerUrl(address) {
  return `${PROVIDER_PATH}/${address}`;
}

/**
 * A subname on the ENS explorer, which reads the same Sepolia records this app
 * does and shows their write history — the owner, the resolver and every
 * `sla` / `url` / `conformance` / `availability` write, attributed to the
 * address that made it. That makes it the independent check on the ENS half
 * of what this app claims, which is why the name is a link wherever it is
 * presented as an identifier rather than mentioned in prose.
 *
 * Here rather than in `packages/sdk/ens.js`: that file is the choke point for
 * ENS *reads*, and this resolves nothing — it is a URL builder, and it sits
 * with the app's other URL builders so the dashboard and the registration
 * wizard share one.
 *
 * @param {string} name a full ENS name, e.g. `weather.verdikt.eth`
 */
export function ensExplorerUrl(name) {
  return `https://explorer.ens.dev/${encodeURIComponent(name)}`;
}

/**
 * A click handler for an in-app `<a href>`: lets a modifier-click or a
 * non-primary button open the link normally (new tab, new window, etc.),
 * and otherwise intercepts the navigation for the SPA router.
 * @param {(path: string) => void} go
 * @param {string} path
 */
export function navigateOnClick(go, path) {
  return (/** @type {MouseEvent} */ event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    go(path);
  };
}

/** @param {string} pathname */
function normalize(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

/**
 * @param {URL} url
 * @returns {{
 *   view: 'landing'|'marketplace'|'service'|'manage'|'provider'|'register'|'withdraw'|'how'|'terms'|'privacy',
 *   slug: string|null,
 *   address: string|null,
 *   rejected: string|null,
 *   canonicalPath: string
 * }}
 */
export function parseRoute(url) {
  const legacyProvider = url.searchParams.get('provider');
  // A junk legacy param is rewritten away rather than reported: the URL that
  // carried it does not survive, so there would be nothing on screen for a
  // message to refer to.
  if (legacyProvider) {
    return ADDRESS.test(legacyProvider)
      ? { view: 'provider', slug: null, address: legacyProvider, rejected: null, canonicalPath: providerUrl(legacyProvider) }
      : { view: 'provider', slug: null, address: null, rejected: null, canonicalPath: PROVIDER_PATH };
  }

  const path = normalize(url.pathname);
  const staticView = STATIC_VIEWS[path];
  if (staticView) return { view: /** @type {any} */ (staticView), slug: null, address: null, rejected: null, canonicalPath: path };

  const service = path.match(/^\/services\/([^/]+)(\/manage)?$/);
  if (service) {
    try {
      const slug = decodeURIComponent(service[1]);
      return { view: service[2] ? 'manage' : 'service', slug, address: null, rejected: null, canonicalPath: path };
    } catch (e) {
      if (e instanceof URIError) {
        return { view: 'marketplace', slug: null, address: null, rejected: null, canonicalPath: MARKETPLACE_PATH };
      }
      throw e;
    }
  }

  if (path === PROVIDER_PATH) return { view: 'provider', slug: null, address: null, rejected: null, canonicalPath: path };
  const provider = path.match(/^\/provider\/(.+)$/);
  if (provider) {
    // Unlike an unrecognized path, a malformed address keeps its URL: the
    // page names what it rejected, which a rewrite to /provider could not.
    return ADDRESS.test(provider[1])
      ? { view: 'provider', slug: null, address: provider[1], rejected: null, canonicalPath: path }
      : { view: 'provider', slug: null, address: null, rejected: provider[1], canonicalPath: path };
  }

  // A typo or an old bookmark to a path that never existed isn't worth a
  // dedicated 404 view — send it to the listing.
  return { view: 'marketplace', slug: null, address: null, rejected: null, canonicalPath: MARKETPLACE_PATH };
}

const TITLES = /** @type {Record<string, string>} */ ({
  landing: 'Verdikt — Verified x402 API Marketplace',
  marketplace: 'Marketplace — Verdikt',
  provider: 'Provider — Verdikt',
  register: 'List a service — Verdikt',
  withdraw: 'Withdraw — Verdikt',
  how: 'How it works — Verdikt',
  terms: 'Terms — Verdikt',
  privacy: 'Privacy — Verdikt'
});

/** @param {ReturnType<typeof parseRoute>} route */
export function titleFor(route) {
  if (route.view === 'service') return `${route.slug} — Verdikt`;
  if (route.view === 'manage') return `Manage ${route.slug} — Verdikt`;
  return TITLES[route.view] ?? 'Verdikt';
}
