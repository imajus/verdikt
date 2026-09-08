// The one place the dashboard shapes its own URL. Query params, not paths:
// `web` is a static single page (CLAUDE.md), so there is no server to
// configure an SPA fallback on, and query params need none either.
//
// Every function here is pure: takes a URL, returns a value or a new URL, and
// never touches `location`/`history` itself — the one caller that has a real
// `location`/`history` (main.js) is the one that calls `history.replaceState`
// with what these compute. That is what keeps this file testable in plain
// Node, with no DOM emulation dependency for one file to need.
//
// `?provider=0x…` predates this file and is a public, shareable deep link to
// any provider's page — it must keep working with no `?view=` at all, which
// is why readRoute treats a bare `provider` param as `view: 'provider'`.

const VIEWS = /** @type {const} */ (['marketplace', 'provider', 'how']);

/**
 * @param {URL} url
 * @returns {{ view: 'marketplace'|'provider'|'how', service: string|null, provider: string|null }}
 */
export function readRoute(url) {
  const params = url.searchParams;
  const provider = params.get('provider');
  const requestedView = params.get('view');
  /** @type {'marketplace'|'provider'|'how'} */
  const view = requestedView && /** @type {readonly string[]} */ (VIEWS).includes(requestedView)
    ? /** @type {'marketplace'|'provider'|'how'} */ (requestedView)
    : provider
      ? 'provider'
      : 'marketplace';
  return { view, service: params.get('service'), provider };
}

/**
 * @param {URL} url
 * @param {string} slug
 * @returns {URL}
 */
export function withService(url, slug) {
  const next = new URL(url);
  next.searchParams.set('service', slug);
  return next;
}

/**
 * @param {URL} url
 * @param {string} address
 * @returns {URL}
 */
export function withProvider(url, address) {
  const next = new URL(url);
  next.searchParams.set('provider', address);
  next.searchParams.set('view', 'provider');
  return next;
}

/**
 * @param {URL} url
 * @param {string} view
 * @returns {URL}
 */
export function withView(url, view) {
  const next = new URL(url);
  next.searchParams.set('view', view);
  return next;
}
