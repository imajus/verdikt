import { describe, expect, it } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { landing, legalFooter, privacy, terms } from './pages.js';

const stringify = (template) => Array.from(renderToIterable(template)).join('');

describe('static pages', () => {
  it('renders the landing page with a marketplace call to action', () => {
    const html = stringify(landing(() => {}));
    expect(html).toContain('Browse the marketplace');
    expect(html).toContain('/marketplace');
  });
  it('renders terms and privacy with distinct headings', () => {
    expect(stringify(terms())).toContain('Terms of Service');
    expect(stringify(privacy())).toContain('Privacy Policy');
  });
  it('renders a footer with both legal links', () => {
    const html = stringify(legalFooter(() => {}));
    expect(html).toContain('/terms');
    expect(html).toContain('/privacy');
  });
});
