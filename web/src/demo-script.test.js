import { describe, expect, it } from 'vitest';
import { DEMO_DISCLOSURE, DEMO_SERVICE_URL, DEMO_SLUG, DEMO_STEPS } from './demo-script.js';

const TX = /^0x[0-9a-f]{64}$/;
const HTTPS = /^https:\/\//;

describe('DEMO_STEPS', () => {
  it('has at least the four turns the demo scenario needs', () => {
    expect(DEMO_STEPS.length).toBeGreaterThanOrEqual(4);
  });
  it('gives every turn a speaker and body text', () => {
    for (const step of DEMO_STEPS) {
      expect(['agent', 'verdikt', 'record']).toContain(step.from);
      expect(step.text.length).toBeGreaterThan(0);
    }
  });
  it('links external steps to well-formed https urls and internal ones to an in-app path', () => {
    for (const step of DEMO_STEPS) {
      if (!step.link) continue;
      expect(step.link.href).toMatch(step.link.internal ? /^\// : HTTPS);
      expect(step.link.label.length).toBeGreaterThan(0);
    }
  });
  it('points the payment link at a real Base Sepolia transaction hash', () => {
    const payment = DEMO_STEPS.find((step) => step.link?.href.includes('basescan.org'));
    expect(payment).toBeTruthy();
    const hash = new URL(/** @type {string} */ (payment?.link?.href)).pathname.split('/').pop();
    expect(hash).toMatch(TX);
  });
  it('points the Arc links at the real registry contract and verdict transaction, on the working explorer', () => {
    const arcLinks = DEMO_STEPS.filter((step) => step.link?.href.includes('arcscan.app')).map((step) => /** @type {string} */ (step.link?.href));
    expect(arcLinks.length).toBeGreaterThanOrEqual(2);
    expect(arcLinks.some((href) => href.includes('0xE182626142E63EF440421cb0c5e4DEbeEF76E4Af'))).toBe(true);
    expect(arcLinks.some((href) => TX.test(href.split('/').pop() ?? ''))).toBe(true);
    // web/.impeccable/surfaces/web-src-lit-app-js.md: explorer.testnet.arc.network
    // does not resolve. Nothing here should point at it.
    expect(arcLinks.every((href) => !href.includes('explorer.testnet.arc.network'))).toBe(true);
  });
  it('closes on an in-app link to the demo service’s own page', () => {
    const last = DEMO_STEPS[DEMO_STEPS.length - 1];
    expect(last.link?.internal).toBe(true);
    expect(last.link?.href).toBe(DEMO_SERVICE_URL);
    expect(DEMO_SERVICE_URL).toBe(`/services/${DEMO_SLUG}`);
  });
});

describe('DEMO_DISCLOSURE', () => {
  it('says plainly that the payment and the verdict are not yet one transaction', () => {
    expect(DEMO_DISCLOSURE).toMatch(/not yet one continuous transaction/i);
  });
  it('discloses the fixture payer and the simulated enclave, matching the project’s other disclosures', () => {
    expect(DEMO_DISCLOSURE).toMatch(/fixture/i);
    expect(DEMO_DISCLOSURE).toMatch(/simulator/i);
  });
});
