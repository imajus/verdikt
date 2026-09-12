// A thin wrapper around @plausible-analytics/tracker, the official npm
// client for Plausible Analytics — used here against a self-hosted instance
// (issue #70). initPlausible() dynamically imports and initializes it only
// when both VITE_PLAUSIBLE_ENDPOINT and VITE_PLAUSIBLE_DOMAIN are configured
// (see .env.example): unconfigured, that chunk is never even requested, and
// every track() call stays a no-op — the same "no endpoint configured"
// fallback the newsletter/contact forms use. Bundling the tracker rather
// than loading a remote <script> also means the CSP (vite.config.js) never
// has to allow-list the Plausible origin for script-src, only connect-src.
//
// track() never throws and never assumes a browser exists: main.js calls it
// from real navigation, but wallet.js and wizard.js run under Node in tests
// (vitest.config.js sets environment: 'node'), where `window` itself is
// undefined.

/** @param {Record<string, string|undefined>} env */
export async function initPlausible(env) {
  if (!env.VITE_PLAUSIBLE_ENDPOINT || !env.VITE_PLAUSIBLE_DOMAIN) return;
  const { init } = await import('@plausible-analytics/tracker');
  // Pageviews are sent explicitly (see main.js's syncRoute) rather than by
  // the library's own history hooks, so its dedup rules never have to agree
  // with the router's — the canonicalizing replaceState and the legacy
  // ?provider= rewrite both need this app's own routing logic to get right,
  // not a generic pushState/popstate listener.
  init({ domain: env.VITE_PLAUSIBLE_DOMAIN, endpoint: env.VITE_PLAUSIBLE_ENDPOINT, autoCapturePageviews: false });
}

/**
 * @param {string} name
 * @param {{ props?: Record<string, string> }} [options]
 */
export function track(name, options) {
  if (typeof window === 'undefined') return;
  /** @type {any} */ (window).plausible?.(name, options);
}
