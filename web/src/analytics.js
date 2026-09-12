// Thin wrapper around a self-hosted Plausible Analytics script (issue #70).
// initPlausible() injects the script only when both VITE_PLAUSIBLE_SRC and
// VITE_PLAUSIBLE_DOMAIN are configured (see .env.example) — unset, this file
// touches neither the DOM nor a third party, the same "no endpoint
// configured" fallback the newsletter/contact forms use.
//
// track() never throws and never assumes a browser exists: main.js calls it
// from real navigation, but wallet.js and wizard.js run under Node in tests
// (vitest.config.js sets environment: 'node'), where `window` itself is
// undefined.

/** @param {Record<string, string|undefined>} env */
export function initPlausible(env) {
  if (!env.VITE_PLAUSIBLE_SRC || !env.VITE_PLAUSIBLE_DOMAIN) return;
  const script = document.createElement('script');
  script.defer = true;
  script.src = env.VITE_PLAUSIBLE_SRC;
  script.dataset.domain = env.VITE_PLAUSIBLE_DOMAIN;
  document.head.append(script);
}

/**
 * @param {string} name
 * @param {{ props?: Record<string, string> }} [options]
 */
export function track(name, options) {
  if (typeof window === 'undefined') return;
  /** @type {any} */ (window).plausible?.(name, options);
}
