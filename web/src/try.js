// The guided "try it" demo on /try (issue #66). A judge or a visitor clicks
// through one real, already-mined failure and its refund without connecting a
// wallet or spending anything — every step's link is hardcoded in
// demo-script.js from docs/evidence/, never fetched live, so this page can't
// break or go stale.
//
// Linear and one control on purpose: the FAIL/refund path is the one that
// shows what makes Verdikt different (auto-refund, no dispute step), so there
// is nothing here for a visitor to branch on — only a Send/Next button
// revealing the next turn.

import { LitElement, html, nothing } from 'lit';
import { DEMO_DISCLOSURE, DEMO_STEPS } from './demo-script.js';
import { navigateOnClick } from './router.js';
import { pageHead } from './pages.js';

const WHO_LABEL = /** @type {Record<import('./demo-script.js').DemoStep['from'], string>} */ ({ agent: 'Agent', verdikt: 'Verdikt', record: 'On the record' });

/** @param {import('./demo-script.js').DemoStep} step @param {(path: string) => void} go */
const turn = (step, go) => html`
  <section class="demo-turn demo-${step.from}">
    <p class="demo-who">${WHO_LABEL[step.from]}</p>
    <p class="demo-text">${step.text}</p>
    ${step.link
      ? step.link.internal
        ? html`<a class="demo-link" href=${step.link.href} @click=${navigateOnClick(go, step.link.href)}>${step.link.label} →</a>`
        : html`<a class="demo-link" href=${step.link.href} target="_blank" rel="noopener noreferrer">${step.link.label} ↗</a>`
      : nothing}
  </section>`;

export class VerdiktTry extends LitElement {
  static properties = { revealed: { state: true }, go: { attribute: false } };
  constructor() {
    super();
    this.revealed = 0;
    /** @type {(path: string) => void} */
    this.go = () => {};
  }
  createRenderRoot() { return this; }
  next() {
    if (this.revealed < DEMO_STEPS.length) this.revealed += 1;
  }
  restart() { this.revealed = 0; }
  render() {
    const shown = DEMO_STEPS.slice(0, this.revealed);
    const done = this.revealed >= DEMO_STEPS.length;
    return html`
      <div class="demo-chat" role="log">
        ${shown.map((step) => turn(step, this.go))}
      </div>
      <p class="demo-actions">
        ${done
          ? html`<wa-button appearance="outlined" size="s" @click=${() => this.restart()}>Replay</wa-button>`
          : html`<wa-button size="s" @click=${() => this.next()}>${this.revealed === 0 ? 'Send' : 'Next'}</wa-button><span class="demo-count">${this.revealed} / ${DEMO_STEPS.length}</span>`}
      </p>
      ${done ? html`<p class="demo-disclosure">${DEMO_DISCLOSURE}</p>` : nothing}`;
  }
}

if (!customElements.get('verdikt-try')) customElements.define('verdikt-try', VerdiktTry);

/** @param {(path: string) => void} go */
export const tryPage = (go) => html`
  ${pageHead('Try it yourself', 'One real failure, paid and refunded end to end — every step below links to what actually happened on a public testnet. No wallet, no signup, about 30 seconds.')}
  <section class="block">
    <verdikt-try .go=${go}></verdikt-try>
  </section>`;
