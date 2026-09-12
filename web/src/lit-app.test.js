import { describe, expect, it } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { detailTemplate } from './lit-app.js';

// SSR interleaves `<!--lit-part-->` markers around every binding, which splits
// a rendered sentence mid-phrase. Strip them so an assertion can read the copy
// the way a visitor does.
/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('').replace(/<!--[\s\S]*?-->/g, '');

/** @param {Partial<ListingVerdict>} overrides @returns {ListingVerdict} */
const verdict = (overrides) => ({
  serviceId: `0x${'11'.repeat(32)}`,
  requestId: `0x${'ab'.repeat(32)}`,
  outcome: 'PASS',
  payer: '0xA11ce00000000000000000000000000000000001',
  paidAmount: 1000n,
  failedClause: `0x${'00'.repeat(32)}`,
  blockNumber: 100n,
  transactionHash: null,
  refunded: 0n,
  failedClauseId: null,
  ...overrides
});

/** @param {Partial<Listing>} overrides @returns {Listing} */
const listing = (overrides) => ({
  serviceId: `0x${'11'.repeat(32)}`,
  slug: 'weather',
  name: 'weather.verdikt.eth',
  provider: '0xA11ce00000000000000000000000000000000001',
  status: 'ACTIVE',
  deposit: 10n * 10n ** 18n,
  endpoint: 'https://provider.example/weather',
  payTo: '0x2222222222222222222222222222222222222222',
  namingLayer: 'ok',
  contested: false,
  sla: null,
  slaRaw: null,
  published: { conformance: 1000, availability: 1000 },
  unpublished: { conformance: 1000, availability: 1000, counts: { pass: 0, fail: 0, down: 0, total: 0 } },
  history: [],
  ...overrides
});

// An empty window scores 1000 on both ratios (packages/sla/aggregate.js), but
// the two presumptions are not equally defensible on screen: conformance is
// about the responses that arrived, availability about whether any arrived at
// all — which is exactly what nobody has tested yet.
describe('a service with no verdicts', () => {
  it('shows availability as N/A while conformance keeps the presumption', () => {
    const html = stringify(detailTemplate(listing({})));
    expect(html).toContain('N/A');
    expect(html).toContain('100.0%');
  });

  it('says so in the computed scores it offers while nothing is published', () => {
    const html = stringify(
      detailTemplate(listing({ published: { conformance: null, availability: null } }))
    );
    expect(html).toContain('N/A availability');
  });
});

describe('a service with verdicts', () => {
  it('shows the published availability as a percentage', () => {
    const html = stringify(
      detailTemplate(
        listing({
          published: { conformance: 1000, availability: 958 },
          history: [verdict({})]
        })
      )
    );
    expect(html).toContain('95.8%');
    expect(html).not.toContain('N/A');
  });
});
