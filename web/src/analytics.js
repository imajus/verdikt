// A thin wrapper around @plausible-analytics/tracker, the official npm
// client for Plausible Analytics — used here against a self-hosted instance
// (issue #70). initPlausible() dynamically imports and initializes it only
// when both VITE_PLAUSIBLE_ENDPOINT and VITE_PLAUSIBLE_DOMAIN are configured
// (see .env.example): unconfigured, that chunk is never even requested, and
// every track() call stays a no-op — the same "no endpoint configured"
// fallback the newsletter/contact forms use. Bundling the tracker rather
// than loading a remote <script> also means the CSP (web/public/_headers)
// never has to allow-list the Plausible origin for script-src.
//
// track() never throws and never assumes a browser exists: main.js calls it
// from real navigation, but wallet.js and wizard.js run under Node in tests
// (vitest.config.js sets environment: 'node'), where `window` itself is
// undefined.

/**
 * `u` overrides the URL the tracker would otherwise read off `location` at
 * send time; only the queue below sets it.
 * @typedef {{ props?: Record<string, string>, u?: string }} TrackOptions
 */

/**
 * Events fired between initPlausible() starting and its dynamic import()
 * resolving — `null` whenever track() may call through directly, which is
 * both before init starts and after it finishes. The tracker drains no queue
 * of its own: its init() simply assigns `window.plausible` at the very end,
 * so anything tracked while the chunk is in flight would otherwise vanish.
 * main.js does exactly that — it calls initPlausible() and then, in the same
 * tick, syncRoute(), which sends the first pageview of the session.
 * @type {Array<[string, TrackOptions | undefined]> | null}
 */
let pending = null;

/** @param {Record<string, string|undefined>} env */
export async function initPlausible(env) {
  if (!env.VITE_PLAUSIBLE_ENDPOINT || !env.VITE_PLAUSIBLE_DOMAIN) return;
  pending = [];
  const { init } = await import('@plausible-analytics/tracker');
  // Pageviews are sent explicitly (see main.js's syncRoute) rather than by
  // the library's own history hooks, so its dedup rules never have to agree
  // with the router's — the canonicalizing replaceState and the legacy
  // ?provider= rewrite both need this app's own routing logic to get right,
  // not a generic pushState/popstate listener.
  try {
    init({ domain: env.VITE_PLAUSIBLE_DOMAIN, endpoint: env.VITE_PLAUSIBLE_ENDPOINT, autoCapturePageviews: false });
  } finally {
    // Drained even if init() threw, so a failed initialization costs the
    // queued events rather than silently swallowing every later one too.
    const queued = pending;
    pending = null;
    for (const [name, options] of queued ?? []) track(name, options);
  }
}

/**
 * @param {string} name
 * @param {TrackOptions} [options]
 */
export function track(name, options) {
  if (typeof window === 'undefined') return;
  // `u` pins the event to the URL it was fired on rather than the one the
  // page happens to be showing once the chunk lands — the tracker defaults
  // that field to location.href at send time.
  if (pending) return void pending.push([name, { u: location.href, ...options }]);
  /** @type {any} */ (window).plausible?.(name, options);
}
