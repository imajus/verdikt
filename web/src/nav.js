// The masthead's navigation — three destinations plus the external links, so
// this is markup generation with no state of its own. `render.js` decides
// which view is active from the already-parsed route; this file only draws it.

const escape = (/** @type {unknown} */ value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const GITHUB_URL = 'https://github.com/imajus/verdikt';
const X_URL = 'https://x.com/verdict402';

const GITHUB_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;
const X_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9.53 6.78 15.17.5h-1.34L8.94 5.87 5.02.5H0l5.92 8.15L0 15.5h1.34l5.19-5.7 4.15 5.7H16L9.53 6.78Zm-1.84 2.02-.6-.83L2.3 1.44h2.06l3.84 5.29.6.83 4.99 6.87h-2.06L7.69 8.8Z"/></svg>`;

/**
 * @param {{ view: 'marketplace'|'provider'|'how', mode: 'live'|'demo', account?: string|null }} args
 */
export function renderNav({ view, mode, account = null }) {
  const item = (/** @type {string} */ target, /** @type {string} */ label) =>
    `<a href="?view=${target}" class="nav-item${view === target ? ' active' : ''}" data-nav="${target}">${escape(label)}</a>`;
  return `
    <nav class="nav">
      <div class="nav-links">
        ${item('marketplace', 'Marketplace')}
        ${mode === 'live' ? item('provider', 'Provider') : ''}
        ${item('how', 'How it works')}
      </div>
      <div class="nav-external">
        <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer" aria-label="Verdikt on GitHub">${GITHUB_ICON}</a>
        <a href="${X_URL}" target="_blank" rel="noopener noreferrer" aria-label="Verdikt on X">${X_ICON}</a>
        ${
          mode === 'live'
            ? account
              ? `<span class="nav-account" title="${escape(account)}">${escape(account.slice(0, 6))}…${escape(account.slice(-4))}</span>`
              : `<button type="button" id="connect-wallet" class="secondary">Connect wallet</button>`
            : ''
        }
      </div>
    </nav>`;
}
