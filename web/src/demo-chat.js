// The guided "try it" chat, embedded on the landing page (issue #66). A judge
// or a visitor sends one message and watches their agent work without
// connecting a wallet or spending anything — every fact and link in the log
// is hardcoded in demo-script.js from docs/evidence/, never fetched live, so
// it can't break or go stale during judging.
//
// Three registers, not one: the visitor's own message and the agent's reply
// are chat bubbles (you lean right, the agent leans left); between them, the
// agent's own status log is a plain mono trail, not a bubble, because it is
// not something either party said — it is what happened. The closing "on the
// record" line is a third register again: the page speaking directly once
// the roleplay is over, so it carries no bubble either.
//
// One click, then it plays itself: Send reveals the visitor's message at
// once and starts a timer chain that reveals the rest on its own pace, the
// log entries closer together than the reply that follows them — nothing
// left to click until Replay. A visitor who has asked for no motion gets the
// same script with no timers at all: Send reveals everything in one frame.

import { LitElement, html, nothing } from 'lit';
import { DEMO_HOST, DEMO_SCRIPT } from './demo-script.js';
import { navigateOnClick } from './router.js';

const BUBBLE_LABEL = { user: 'You', reply: 'Agent' };

/** Milliseconds to wait before revealing the next step, keyed by that step's own kind. */
const STEP_DELAY = { log: 550, reply: 900, coda: 350 };

/** @param {NonNullable<import('./demo-script.js').DemoStep['link']>} link @param {(path: string) => void} go */
const stepLink = (link, go) =>
  link.internal
    ? html`<a class="demo-link" href=${link.href} @click=${navigateOnClick(go, link.href)}>${link.label} →</a>`
    : html`<a class="demo-link" href=${link.href} target="_blank" rel="noopener noreferrer">${link.label} ↗</a>`;

/**
 * Substitutes the tokens a plain string cannot carry: the proxy route gets
 * its underline, a chain amount stays mono even inside prose (DESIGN.md's
 * chain-data rule), and an outcome takes the same dotted mark the ledger
 * tables use, so the log names a FAIL in the page's own voice.
 * @param {import('./demo-script.js').DemoStep} step
 */
const stepText = (step) =>
  step.text.split(/(\{host\}|\{amount\}|\{outcome\})/).map((part) => {
    if (part === '{host}') return html`<span class="demo-host">${DEMO_HOST}</span>`;
    if (part === '{amount}' && step.amount) return html`<code>${step.amount}</code>`;
    if (part === '{outcome}' && step.outcome) return html`<span class="outcome ${step.outcome}"><i class="dot"></i>${step.outcome.toUpperCase()}</span>`;
    return part;
  });

/** A chat bubble: the visitor's own message, or the agent's reply to it. @param {import('./demo-script.js').DemoStep} step @param {(path: string) => void} go */
const bubble = (step, go) => html`
  <div class="demo-turn demo-${step.kind}">
    <p class="demo-who">${BUBBLE_LABEL[/** @type {'user'|'reply'} */ (step.kind)]}</p>
    <div class="demo-bubble">
      <p class="demo-text">${stepText(step)}</p>
      ${step.link ? stepLink(step.link, go) : nothing}
    </div>
  </div>`;

/**
 * One line of the agent's own status log — not a bubble, because nobody said
 * it. Where the line has evidence behind it, the link opens the line rather
 * than trailing under it: the reader's eye lands on the record itself, and a
 * dense log stays one line per fact instead of two.
 * @param {import('./demo-script.js').DemoStep} step @param {(path: string) => void} go
 */
const logLine = (step, go) => html`
  <li class="demo-log-line">
    ${step.link ? html`${stepLink(step.link, go)} ` : nothing}${stepText(step)}
  </li>`;

/**
 * The page speaking again once the roleplay is over — today just the way back
 * to the record itself, which is why it carries a link and no prose.
 * @param {import('./demo-script.js').DemoStep} step @param {(path: string) => void} go
 */
const coda = (step, go) => html`
  <p class="demo-turn demo-coda">
    ${step.text ? html`${stepText(step)} ` : nothing}${step.link ? stepLink(step.link, go) : nothing}
  </p>`;

/** @typedef {{ kind: 'log', steps: import('./demo-script.js').DemoStep[] }} LogGroup */

/**
 * Consecutive `log` steps render inside one status block; everything else
 * renders on its own. `shown` is already the truncated, revealed-so-far slice.
 * @param {import('./demo-script.js').DemoStep[]} shown @param {(path: string) => void} go
 */
const renderSteps = (shown, go) => {
  /** @type {(import('./demo-script.js').DemoStep|LogGroup)[]} */
  const groups = [];
  for (const step of shown) {
    const last = groups[groups.length - 1];
    if (step.kind === 'log' && last?.kind === 'log') /** @type {LogGroup} */ (last).steps.push(step);
    else groups.push(step.kind === 'log' ? { kind: 'log', steps: [step] } : step);
  }
  return groups.map((group) => {
    if (group.kind === 'log') {
      const logGroup = /** @type {LogGroup} */ (group);
      return html`
        <div class="demo-turn demo-log">
          <p class="demo-who">Agent</p>
          <ul class="demo-log-lines">${logGroup.steps.map((s) => logLine(s, go))}</ul>
        </div>`;
    }
    if (group.kind === 'coda') return coda(/** @type {import('./demo-script.js').DemoStep} */ (group), go);
    return bubble(/** @type {import('./demo-script.js').DemoStep} */ (group), go);
  });
};

export class VerdiktDemoChat extends LitElement {
  static properties = { revealed: { state: true }, go: { attribute: false } };
  constructor() {
    super();
    this.revealed = 0;
    /** @type {(path: string) => void} */
    this.go = () => {};
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
  }
  createRenderRoot() { return this; }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._stop();
  }
  _stop() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }
  /** A visitor who asked for no motion gets the finished script at once, not a slower version of the same wait. */
  _reducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  send() {
    if (this.revealed !== 0) return;
    if (this._reducedMotion()) {
      this.revealed = DEMO_SCRIPT.length;
      return;
    }
    this.revealed = 1;
    this._scheduleNext();
  }
  _scheduleNext() {
    if (this.revealed >= DEMO_SCRIPT.length) return;
    const delay = STEP_DELAY[/** @type {'log'|'reply'|'coda'} */ (DEMO_SCRIPT[this.revealed].kind)] ?? 550;
    this._timer = setTimeout(() => {
      this.revealed += 1;
      this._scheduleNext();
    }, delay);
  }
  restart() {
    this._stop();
    this.revealed = 0;
  }
  render() {
    const shown = DEMO_SCRIPT.slice(0, this.revealed);
    const playing = this.revealed > 0 && this.revealed < DEMO_SCRIPT.length;
    return html`
      <div class="demo-chat" role="log">
        ${renderSteps(shown, this.go)}
      </div>
      <p class="demo-actions">
        ${playing
          ? nothing
          : this.revealed === 0
            ? html`<wa-button size="s" @click=${() => this.send()}>Send</wa-button>`
            : html`<wa-button appearance="outlined" size="s" @click=${() => this.restart()}>Replay</wa-button>`}
      </p>`;
  }
}

if (!customElements.get('verdikt-demo-chat')) customElements.define('verdikt-demo-chat', VerdiktDemoChat);
