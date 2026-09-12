import { describe, expect, it, vi } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { DEMO_STEPS } from './demo-script.js';
import { VerdiktTry, tryPage } from './try.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('');

// Instantiated directly rather than via document.createElement — same reason
// forms/wizard.test.js does: only the element's own logic is under test, and
// @lit-labs/ssr's global customElements shim is enough for that.
describe('the try-it demo element', () => {
  /** @returns {any} */
  const mount = () => new VerdiktTry();

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

  it('shows the honesty disclosure only once the script has finished', () => {
    const el = mount();
    expect(stringify(el.render())).not.toContain('not yet one continuous transaction');
    for (let i = 0; i < DEMO_STEPS.length; i += 1) el.next();
    expect(stringify(el.render())).toContain('not yet one continuous transaction');
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

describe('tryPage', () => {
  it('renders a page head and mounts the demo element', () => {
    const html = stringify(tryPage(() => {}));
    expect(html).toContain('Try it yourself');
    expect(html).toContain('verdikt-try');
  });
});
