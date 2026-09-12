import { afterEach, describe, expect, it, vi } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { DEMO_HOST, DEMO_PAID, DEMO_SCRIPT } from './demo-script.js';
import { VerdiktDemoChat } from './demo-chat.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('');

/** The same markup without @lit-labs/ssr's part comments, for assertions that span an interpolation. */
const plain = (/** @type {unknown} */ template) => stringify(template).replace(/<!--[^]*?-->/g, '');

const LOG_STEP_COUNT = DEMO_SCRIPT.filter((step) => step.kind === 'log').length;

// Instantiated directly rather than via document.createElement — same reason
// forms/wizard.test.js does: only the element's own logic is under test, and
// @lit-labs/ssr's global customElements shim is enough for that.
describe('the try-it demo chat element', () => {
  /** @returns {any} */
  const mount = () => new VerdiktDemoChat();

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts with nothing revealed', () => {
    const el = mount();
    expect(el.revealed).toBe(0);
    expect(stringify(el.render())).not.toContain('demo-turn');
  });

  it('reveals the visitor’s own message at once on send, before any timer fires', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    expect(el.revealed).toBe(1);
    const html = stringify(el.render());
    expect(html).toContain(DEMO_SCRIPT[0].text);
    expect(html).toContain('class="demo-turn demo-user"');
  });

  it('plays the rest of the script on its own timers, with no further click', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    expect(el.revealed).toBe(DEMO_SCRIPT.length);
  });

  it('hides the control entirely while the script is playing, and offers Replay once it finishes', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    expect(stringify(el.render())).not.toContain('<wa-button');
    vi.runAllTimers();
    expect(stringify(el.render())).toContain('Replay');
  });

  it('groups every consecutive log step into one status block', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = stringify(el.render());
    expect(html.match(/class="demo-turn demo-log"/g)?.length).toBe(1);
    expect(html.match(/class="demo-log-line"/g)?.length).toBe(LOG_STEP_COUNT);
  });

  it('flags only the log line naming the SLA failure with the outcome dot, and never leaks its placeholder', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = plain(el.render());
    expect(html.match(/class="outcome fail"/g)?.length).toBe(1);
    expect(html).toContain('<span class="outcome fail"><i class="dot"></i>FAIL</span>');
    expect(html).not.toContain('{outcome}');
  });

  // Evidence opens its line rather than hanging under it, so a log line with a
  // link starts with that link and finishes in prose — one line per fact.
  it('opens a log line with its evidence link rather than trailing it', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = plain(el.render());
    const linked = DEMO_SCRIPT.filter((step) => step.kind === 'log' && step.link);
    for (const step of linked) {
      const line = html.slice(html.indexOf(`href="${step.link?.href}"`));
      expect(line.indexOf(/** @type {string} */ (step.link?.label))).toBeLessThan(line.indexOf(step.text.replace('{outcome}', 'FAIL').slice(-24)));
    }
    expect(html).not.toContain('class="demo-link" style="display:block"');
  });

  it('renders the agent’s reply as a left-leaning bubble, distinct from the log', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = plain(el.render());
    const reply = /** @type {{text: string}} */ (DEMO_SCRIPT.find((step) => step.kind === 'reply'));
    expect(html).toContain('class="demo-turn demo-reply"');
    for (const segment of reply.text.split(/\{host\}|\{amount\}/)) expect(html).toContain(segment);
  });

  it('sets the amount inside the reply in mono, underlines the route, and leaks no placeholder', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = plain(el.render());
    expect(html).toContain(`<code>${DEMO_PAID}</code>`);
    expect(html).toContain(`<span class="demo-host">${DEMO_HOST}</span>`);
    expect(html).not.toMatch(/\{host\}|\{amount\}|\{outcome\}/);
  });

  it('renders the closing record as plain prose, not a bubble', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = stringify(el.render());
    const codaAt = html.indexOf('demo-turn demo-coda');
    expect(codaAt).toBeGreaterThan(-1);
    expect(html.slice(codaAt)).not.toContain('demo-bubble');
  });

  it('links every revealed step that carries one, external links opening in a new tab', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = stringify(el.render());
    for (const step of DEMO_SCRIPT) {
      if (!step.link) continue;
      expect(html).toContain(step.link.href);
    }
    expect(html).toContain('target="_blank"');
  });

  it('accepts a go callback for the closing in-app link without throwing', () => {
    vi.useFakeTimers();
    const go = vi.fn();
    const el = mount();
    el.go = go;
    el.send();
    vi.runAllTimers();
    const html = stringify(el.render());
    const last = DEMO_SCRIPT[DEMO_SCRIPT.length - 1];
    expect(html).toContain(/** @type {string} */ (last.link?.href));
    expect(go).not.toHaveBeenCalled();
  });

  it('restarts to nothing revealed', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    el.restart();
    expect(el.revealed).toBe(0);
  });

  it('ignores a second send while the script is already playing or finished', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    el.send();
    expect(el.revealed).toBe(1);
    vi.runAllTimers();
    el.send();
    expect(el.revealed).toBe(DEMO_SCRIPT.length);
  });

  it('reveals the whole script at once for a visitor who prefers no motion, rather than a slower version of the same wait', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const el = mount();
    el.send();
    expect(el.revealed).toBe(DEMO_SCRIPT.length);
  });
});
