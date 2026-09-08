// The SLA editor, as a mounted DOM node rather than a re-rendered string.
//
// render.js's old provider view rebuilt the whole page on every keystroke and
// restored the caret by hand (main.js's `preserveFocus`-shaped hack, now
// gone) — a textarea that never gets destroyed needs none of that. This
// module owns exactly the elements inside its container and nothing else.

import { parseSla } from '@verdikt/sla';
import { publishSla } from '../actions.js';

/**
 * Pure: the same check `renderProvider`'s old inline validator ran, now
 * exported so it is testable on its own rather than only through a DOM.
 * Mirrors the wording the old string-rendered version used, since
 * `web/src/marketplace.test.js` documented that wording as behaviour worth
 * keeping ("accepts a valid SLA", "rejects an invalid SLA").
 * @param {string} source
 * @returns {{ ok: boolean, message: string }}
 */
export function describeSlaValidity(source) {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, message: 'Paste an SLA to validate it.' };
  try {
    const parsed = parseSla(trimmed);
    return { ok: true, message: `Valid. ${parsed.clauses.length} clause(s); the verifier would enforce all of them.` };
  } catch (error) {
    return { ok: false, message: /** @type {Error} */ (error).message };
  }
}

/**
 * @param {HTMLElement} container an empty element this function owns completely
 * @param {{ slug: string, slaRaw: string | null }} listing
 * @param {{ walletClientFor: () => { sendTransaction: Function }, sepoliaChainConfig: object }} deps
 */
export function mountSlaEditor(container, listing, deps) {
  container.innerHTML = `
    <textarea id="sla-draft" spellcheck="false" rows="14">${escapeHtml(listing.slaRaw ?? '')}</textarea>
    <p class="check" id="sla-check"><i class="dot"></i></p>
    <button type="button" id="sla-publish" disabled>Publish SLA</button>
    <p class="form-status" id="sla-status" hidden></p>`;
  const textarea = /** @type {HTMLTextAreaElement} */ (container.querySelector('#sla-draft'));
  const check = /** @type {HTMLElement} */ (container.querySelector('#sla-check'));
  const button = /** @type {HTMLButtonElement} */ (container.querySelector('#sla-publish'));
  const status = /** @type {HTMLElement} */ (container.querySelector('#sla-status'));
  const validate = () => {
    const { ok, message } = describeSlaValidity(textarea.value);
    check.className = `check ${ok ? 'ok' : 'bad'}`;
    check.textContent = message;
    button.disabled = !ok;
  };
  textarea.addEventListener('input', validate);
  validate();
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.hidden = false;
    status.textContent = 'Sending…';
    try {
      const walletClient = deps.walletClientFor();
      const { hash } = await publishSla({ walletClient, slug: listing.slug, value: textarea.value.trim() });
      status.textContent = `Sent: ${hash}`;
    } catch (error) {
      status.textContent = `Failed: ${/** @type {Error} */ (error).message}`;
    } finally {
      button.disabled = false;
    }
  });
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
