import { describe, expect, it } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { legalFooter, privacy, terms } from './pages.js';

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
