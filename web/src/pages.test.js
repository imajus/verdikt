import { describe, expect, it } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { legalFooter, privacy, terms, withdrawPrompt } from './pages.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('');

describe('static pages', () => {
  it('renders terms and privacy with distinct headings', () => {
    expect(stringify(terms())).toContain('Terms of Service');
    expect(stringify(privacy())).toContain('Privacy Policy');
  });
  it('renders a footer with both legal links', () => {
    const html = stringify(legalFooter(() => {}));
    expect(html).toContain('/terms');
    expect(html).toContain('/privacy');
  });
  // The landing page now posts an email address to a third-party service, so
  // "we collect nothing" stopped being true and the policy has to say where it
  // goes. A form shipped without this section is the failure worth a test.
  it('discloses that the landing forms send an address off the page', () => {
    const html = stringify(privacy());
    expect(html).toContain('third-party form service');
    expect(html).toContain('deletion request');
  });
});

describe('withdrawPrompt', () => {
  const OWNER = '0xA11ce00000000000000000000000000000000001';
  it('prompts a connect, with no address input, when no wallet is connected', () => {
    const html = stringify(withdrawPrompt('live', null, () => {}));
    expect(html).toContain('Connect the wallet');
    expect(html).not.toContain('<input');
  });
  it('mounts the withdraw control once a wallet is connected', () => {
    const html = stringify(withdrawPrompt('live', OWNER, () => {}));
    expect(html).toContain('<verdikt-withdraw');
    expect(html).not.toContain('Connect the wallet');
  });
  it('says a live chain is needed in demo mode, even with a wallet connected', () => {
    const html = stringify(withdrawPrompt('demo', OWNER, () => {}));
    expect(html).toContain('needs a live chain');
    expect(html).not.toContain('<verdikt-withdraw');
  });
});
