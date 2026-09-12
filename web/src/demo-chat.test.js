import { afterEach, describe, expect, it, vi } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { DEMO_HOST, DEMO_PAID, DEMO_SCRIPT, DEMO_USER_MESSAGE, DEMO_VALUES } from './demo-script.js';
import { VerdiktDemoChat } from './demo-chat.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('');

/** The same markup without @lit-labs/ssr's part comments, for assertions that span an interpolation. */
const plain = (/** @type {unknown} */ template) => stringify(template).replace(/<!--[^]*?-->/g, '');

const LOG_STEP_COUNT = DEMO_SCRIPT.filter((step) => step.kind === 'log').length;

/** The rendered log, one `<li>`'s inner markup per entry. */
const logLines = (/** @type {string} */ html) =>
  html.split('<li class="demo-log-line">').slice(1).map((rest) => rest.slice(0, rest.indexOf('</li>')));

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

  // At rest the entry has to read as a chat rather than as a button with no
  // object: the message is sitting in the composer, so Send has something
  // visible to send.
  it('shows the message waiting to be sent before anything is clicked', () => {
    const html = plain(mount().render());
    expect(html).toContain('class="demo-composer"');
    expect(html.slice(html.indexOf('class="demo-draft"'))).toContain(DEMO_USER_MESSAGE);
    expect(html).toContain('>Send<');
  });

  // The composer clears the way a real one does — the message is in the
  // conversation now, not still waiting to be sent.
  it('clears the draft once the message has been sent', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    const draft = plain(el.render());
    expect(draft.slice(draft.indexOf('class="demo-draft"'))).not.toContain(DEMO_USER_MESSAGE);
    vi.runAllTimers();
    const done = plain(el.render());
    expect(done.slice(done.indexOf('class="demo-draft"'))).not.toContain(DEMO_USER_MESSAGE);
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

  // One control for the whole script, never two and never none: it holds its
  // place so nothing moves under the pointer that just clicked it, and so the
  // keyboard has something to come back to.
  it('keeps the one control in place — disabled while the script plays, Replay once it finishes', () => {
    vi.useFakeTimers();
    const el = mount();
    expect(stringify(el.render()).match(/<wa-button/g)?.length).toBe(1);
    el.send();
    const playing = stringify(el.render());
    expect(playing.match(/<wa-button/g)?.length).toBe(1);
    expect(playing).toContain('disabled');
    expect(playing).not.toContain('Replay');
    vi.runAllTimers();
    const done = stringify(el.render());
    expect(done.match(/<wa-button/g)?.length).toBe(1);
    expect(done).toContain('Replay');
    expect(done).not.toContain('disabled');
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

  // The log is the one register nobody spoke, and a second "Agent" caption
  // directly above the agent's own reply labelled the wrong thing twice.
  it('labels the two bubbles and leaves the status log unattributed', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = stringify(el.render());
    expect(html.match(/class="demo-who"/g)?.length).toBe(2);
    const log = html.slice(html.indexOf('demo-turn demo-log'), html.indexOf('demo-turn demo-reply'));
    expect(log).not.toContain('demo-who');
  });

  // Every figure the log quotes is set apart from the words around it, or a
  // reader has to parse eight lines of one grey to find the three that matter.
  it('sets each chain figure apart from the mono it sits in', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = plain(el.render());
    for (const value of new Set(Object.values(DEMO_VALUES))) {
      expect(html).toContain(`<code class="demo-value">${value}</code>`);
    }
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
    const lines = logLines(plain(el.render()));
    expect(lines.length).toBe(LOG_STEP_COUNT);
    const linked = lines.filter((line) => line.includes('<a '));
    expect(linked.length).toBe(DEMO_SCRIPT.filter((step) => step.kind === 'log' && step.link).length);
    for (const line of linked) expect(line.trimStart().startsWith('<a ')).toBe(true);
  });

  it('renders the agent’s reply as a left-leaning bubble, distinct from the log', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = plain(el.render());
    const reply = /** @type {{text: string}} */ (DEMO_SCRIPT.find((step) => step.kind === 'reply'));
    expect(html).toContain('class="demo-turn demo-reply"');
    for (const segment of reply.text.split(/\{[a-z]+\}/)) expect(html).toContain(segment);
  });

  it('sets the amount inside the reply in mono, underlines the route, and leaks no placeholder', () => {
    vi.useFakeTimers();
    const el = mount();
    el.send();
    vi.runAllTimers();
    const html = plain(el.render());
    const reply = html.slice(html.indexOf('demo-turn demo-reply'));
    expect(reply).toContain(`<code class="demo-value">${DEMO_PAID}</code>`);
    expect(html).toContain(`<span class="demo-host">${DEMO_HOST}</span>`);
    expect(html).not.toMatch(/\{[a-z]+\}/);
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
