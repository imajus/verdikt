// The guided "try it" chat, embedded on the landing page (issue #66). A judge
// or a visitor clicks through one real, already-mined failure and its refund
// without connecting a wallet or spending anything — every step's link is
// hardcoded in demo-script.js from docs/evidence/, never fetched live, so it
// can't break or go stale during judging.
//
// It reads as a chat because the flow is one: the visitor's own click sends
// the next turn, agent turns lean right, Verdikt's replies lean left. The
// closing "on the record" line is not a turn — it's the page speaking again
// once the exchange is over — so it carries no bubble.
//
// Linear and one control on purpose: the FAIL/refund path is the one that
// shows what makes Verdikt different (auto-refund, no dispute step), so there
// is nothing here for a visitor to branch on — only a Send/Next button
// revealing the next turn. landing.js owns the surrounding heading, intro and
// the honesty disclosure (an always-visible margin caption, not something
// this element gates behind "done") — this file is only the exchange itself.

import { LitElement, html, nothing } from 'lit';
import { DEMO_STEPS } from './demo-script.js';
import { navigateOnClick } from './router.js';

const WHO_LABEL = /** @type {Record<import('./demo-script.js').DemoStep['from'], string>} */ ({ agent: 'Agent', verdikt: 'Verdikt', record: 'On the record' });

/** @param {NonNullable<import('./demo-script.js').DemoStep['link']>} link @param {(path: string) => void} go */
const stepLink = (link, go) =>
  link.internal
    ? html`<a class="demo-link" href=${link.href} @click=${navigateOnClick(go, link.href)}>${link.label} →</a>`
    : html`<a class="demo-link" href=${link.href} target="_blank" rel="noopener noreferrer">${link.label} ↗</a>`;

/** @param {import('./demo-script.js').DemoStep} step @param {(path: string) => void} go */
const turn = (step, go) =>
  step.from === 'record'
    ? html`<p class="demo-turn demo-record">${step.text}${step.link ? html` ${stepLink(step.link, go)}` : nothing}</p>`
    : html`
      <div class="demo-turn demo-${step.from}">
        <p class="demo-who">${WHO_LABEL[step.from]}</p>
        <div class="demo-bubble">
          <p class="demo-text">${step.text}</p>
          ${step.link ? stepLink(step.link, go) : nothing}
        </div>
      </div>`;

export class VerdiktDemoChat extends LitElement {
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
      </p>`;
  }
}

if (!customElements.get('verdikt-demo-chat')) customElements.define('verdikt-demo-chat', VerdiktDemoChat);
