import { byReputation, loadMarketplace } from './marketplace.js';
import { renderApp } from './render.js';
import { createSource } from './source.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
// Vite injects the env; `import.meta.env` is not in the shared jsconfig's lib.
const { mode, deps } = createSource(/** @type {any} */ (import.meta).env ?? {});

const params = new URLSearchParams(location.search);
/** @type {string|null} */
let selectedSlug = params.get('service');
/** The provider view is the same data narrowed to one address, not a second app. */
const provider = params.get('provider');
let slaDraft = '';

async function main() {
  root.innerHTML = '<p class="empty">Reading Arc and the naming layer…</p>';
  try {
    const marketplace = await loadMarketplace(deps);
    marketplace.services.sort(byReputation);
    draw(marketplace);
  } catch (error) {
    root.innerHTML = `<p class="note warn">Could not load the marketplace: ${/** @type {Error} */ (error).message}</p>`;
  }
}

/** @param {Marketplace} marketplace */
function draw(marketplace) {
  root.innerHTML = renderApp(marketplace, mode, 'marketplace', selectedSlug, provider, slaDraft);
  const editor = /** @type {HTMLTextAreaElement|null} */ (root.querySelector('#sla-draft'));
  if (editor) {
    editor.addEventListener('input', () => {
      slaDraft = editor.value;
      const at = editor.selectionStart;
      draw(marketplace);
      const next = /** @type {HTMLTextAreaElement|null} */ (root.querySelector('#sla-draft'));
      // Re-rendering replaces the node, so the caret has to be put back or
      // typing jumps to the end after every keystroke.
      if (next) {
        next.focus();
        next.setSelectionRange(at, at);
      }
    });
  }
  for (const row of root.querySelectorAll('.row[data-slug]')) {
    row.addEventListener('click', () => {
      selectedSlug = /** @type {HTMLElement} */ (row).dataset.slug ?? null;
      // Keeps a service's page linkable — the point of a marketplace is that
      // someone can send you the listing they are looking at.
      const url = new URL(location.href);
      url.searchParams.set('service', String(selectedSlug));
      history.replaceState(null, '', url);
      draw(marketplace);
    });
  }
}

main();
