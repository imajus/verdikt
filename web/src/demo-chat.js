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
// The composer under the exchange holds the message before it is sent, so the
// entry reads as a chat at rest rather than as a button with no object, and
// `Send` has something visible to send. It clears once sent, the way a real
// composer does, but keeps its height so nothing below it moves. The control
// is one element for the whole lifetime of the script — Send, disabled while
// the script plays, then Replay — so it never jumps under the pointer and
// keyboard focus survives the transition.
//
// One click, then it plays itself: Send reveals the visitor's message at
// once and starts a timer chain that reveals the rest on its own pace, the
// log entries closer together than the reply that follows them — nothing
// left to click until Replay. A visitor who has asked for no motion gets the
// same script with no timers at all: Send reveals everything in one frame.

import { LitElement, html, nothing } from 'lit';
import { DEMO_HOST, DEMO_SCRIPT, DEMO_USER_MESSAGE, DEMO_VALUES } from './demo-script.js';
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
 * Substitutes the tokens a plain string cannot carry: the proxy route gets its
 * underline, an outcome takes the same dotted mark the ledger tables use so the
 * log names a FAIL in the page's own voice, and every named figure is set apart
 * from the words around it — mono inside the reply's prose (DESIGN.md's
 * chain-data rule), and ink inside a log line that is already mono, which is
 * what lets the three figures be found in it at all.
 * @param {import('./demo-script.js').DemoStep} step
 */
const stepText = (step) =>
  step.text.split(/(\{[a-z]+\})/).map((part) => {
    if (!/^\{[a-z]+\}$/.test(part)) return part;
    if (part === '{host}') return html`<span class="demo-host">${DEMO_HOST}</span>`;
    if (part === '{outcome}' && step.outcome) return html`<span class="outcome ${step.outcome}"><i class="dot"></i>${step.outcome.toUpperCase()}</span>`;
    const value = DEMO_VALUES[part.slice(1, -1)];
    return value ? html`<code class="demo-value">${value}</code>` : part;
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
      // No speaker label: the log is the one register nobody spoke, and a
      // second "AGENT" caption directly above the agent's own reply labelled
      // the wrong thing twice. The continuous rule down its left is what
      // names it — the aside's idiom, for evidence that stands beside a
      // claim rather than making one.
      return html`
        <div class="demo-turn demo-log">
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
    this._refocus = false;
  }
  createRenderRoot() { return this; }
  /**
   * Disabling the control while the script plays blurs it, so a visitor who
   * pressed Enter on Send would come back to the top of the document rather
   * than to the thing they just ran. Focus goes back where it was the moment
   * the control is live again; a pointer user sees nothing, since the ring is
   * `:focus-visible` only. The wait is the button's own render and not ours —
   * it is a Lit element too, and its inner control is still disabled at the
   * point this element has finished updating.
   */
  updated() {
    if (!this._refocus || this.revealed < DEMO_SCRIPT.length) return;
    this._refocus = false;
    const button = /** @type {(HTMLElement & {updateComplete?: Promise<unknown>})|null} */ (this.querySelector('wa-button'));
    Promise.resolve(button?.updateComplete).then(() => button?.focus());
  }
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
  /** The one control, doing whichever of its two jobs the script is up to. @param {boolean} done */
  _act(done) {
    if (done) {
      this.restart();
      return;
    }
    this._refocus = true;
    this.send();
  }
  render() {
    const shown = DEMO_SCRIPT.slice(0, this.revealed);
    const playing = this.revealed > 0 && this.revealed < DEMO_SCRIPT.length;
    const done = this.revealed >= DEMO_SCRIPT.length;
    return html`
      <div class="demo-chat" role="log">
        ${renderSteps(shown, this.go)}
      </div>
      <div class="demo-composer">
        <p class="demo-draft">${this.revealed === 0 ? DEMO_USER_MESSAGE : nothing}</p>
        <wa-button
          size="s"
          appearance=${done ? 'outlined' : 'accent'}
          ?disabled=${playing}
          @click=${() => this._act(done)}
        >${done ? 'Replay' : 'Send'}</wa-button>
      </div>`;
  }
}

if (!customElements.get('verdikt-demo-chat')) customElements.define('verdikt-demo-chat', VerdiktDemoChat);
