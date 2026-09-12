// The one copy-to-clipboard button, shared by the endpoint URL (lit-app.js's
// callSection) and the address component (address-view.js). It manages its
// own state directly on the button rather than through a re-render: the
// template it sits in is a pure function of data that has not changed, so a
// later render of the same template only resets the button to idle — which
// is the state it should be in by then anyway.

import { html } from 'lit';

const copyIcon = () => html`<svg class="icon-copy" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-9A1.5 1.5 0 0 0 3 5.5v9A1.5 1.5 0 0 0 4.5 16"/></svg>`;
const checkIcon = () => html`<svg class="icon-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12.5 5.5 5.5L20 6"/></svg>`;

/**
 * Writes `value` to the clipboard and reports back on the button itself.
 * @param {string} value
 */
const copyOnClick = (value) => async (/** @type {Event} */ event) => {
  const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
  const label = button.querySelector('.copy-label');
  if (!label) return;
  // A failure here means no clipboard permission, or no clipboard at all over
  // plain http. Say so rather than claiming a copy that did not happen — the
  // value beside the button is selectable, so there is still a way through.
  let copied;
  try {
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch {
    copied = false;
  }
  button.dataset.state = copied ? 'copied' : 'failed';
  label.textContent = copied ? 'Copied' : 'Select it';
  window.setTimeout(() => {
    button.dataset.state = 'idle';
    label.textContent = 'Copy';
  }, 2000);
};

/** @param {string} value */
export const copyButton = (value) => html`
  <button type="button" class="copy" data-state="idle" aria-label="Copy ${value}" @click=${copyOnClick(value)}>
    ${copyIcon()}${checkIcon()}<span class="copy-label" aria-live="polite">Copy</span>
  </button>`;
