import { describe, expect, it, vi } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { DEMO_STEPS } from './demo-script.js';
import { VerdiktDemoChat } from './demo-chat.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('');

// Instantiated directly rather than via document.createElement — same reason
// forms/wizard.test.js does: only the element's own logic is under test, and
// @lit-labs/ssr's global customElements shim is enough for that.
describe('the try-it demo chat element', () => {
  /** @returns {any} */
  const mount = () => new VerdiktDemoChat();

  it('starts with nothing revealed', () => {
    const el = mount();
    expect(el.revealed).toBe(0);
    expect(stringify(el.render())).not.toContain('demo-turn');
  });

  it('reveals one more turn per click, never past the end of the script', () => {
    const el = mount();
    for (let i = 0; i < DEMO_STEPS.length + 3; i += 1) el.next();
    expect(el.revealed).toBe(DEMO_STEPS.length);
  });

  it('shows exactly the turns revealed so far, in order', () => {
    const el = mount();
    el.next();
    el.next();
    const html = stringify(el.render());
    expect(html).toContain(DEMO_STEPS[0].text);
    expect(html).toContain(DEMO_STEPS[1].text);
    expect(html).not.toContain(DEMO_STEPS[2].text);
  });

  it('labels the control Send before the first turn and Next after', () => {
    const el = mount();
    expect(stringify(el.render())).toContain('>Send<');
    el.next();
    expect(stringify(el.render())).toContain('>Next<');
  });

  it('offers a restart once every turn has been shown, and only then', () => {
    const el = mount();
    expect(stringify(el.render())).not.toContain('Replay');
    for (let i = 0; i < DEMO_STEPS.length; i += 1) el.next();
    expect(stringify(el.render())).toContain('Replay');
    el.restart();
    expect(el.revealed).toBe(0);
  });

  it('renders the closing turn as plain prose, not a chat bubble', () => {
    const el = mount();
    for (let i = 0; i < DEMO_STEPS.length; i += 1) el.next();
    const html = stringify(el.render());
    const recordAt = html.indexOf('demo-turn demo-record');
    expect(recordAt).toBeGreaterThan(-1);
    const tail = html.slice(recordAt);
    expect(tail).not.toContain('demo-bubble');
    expect(tail).not.toContain('demo-who');
  });

  it('links every revealed turn that carries one, external links opening in a new tab', () => {
    const el = mount();
    for (let i = 0; i < DEMO_STEPS.length; i += 1) el.next();
    const html = stringify(el.render());
    for (const step of DEMO_STEPS) {
      if (!step.link) continue;
      expect(html).toContain(step.link.href);
    }
    expect(html).toContain('target="_blank"');
  });

  it('accepts a go callback for the closing in-app link without throwing', () => {
    const go = vi.fn();
    const el = mount();
    el.go = go;
    for (let i = 0; i < DEMO_STEPS.length; i += 1) el.next();
    const html = stringify(el.render());
    const last = DEMO_STEPS[DEMO_STEPS.length - 1];
    expect(html).toContain(/** @type {string} */ (last.link?.href));
    expect(go).not.toHaveBeenCalled();
  });
});
