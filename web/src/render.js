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
