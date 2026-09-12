import { describe, expect, it } from 'vitest';
import { DEMO_HOST, DEMO_LATENCY, DEMO_PAID, DEMO_REFUNDED, DEMO_REPLY, DEMO_SCRIPT, DEMO_SERVICE_URL, DEMO_SLUG, DEMO_USER_MESSAGE, DEMO_VALUES } from './demo-script.js';

const TX = /^0x[0-9a-f]{64}$/;
const HTTPS = /^https:\/\//;

describe('DEMO_SCRIPT', () => {
  it('has at least the six steps the demo scenario needs', () => {
    expect(DEMO_SCRIPT.length).toBeGreaterThanOrEqual(6);
  });
  // Every step says something or points somewhere; the closing one is allowed
  // to be a bare link back to the record.
  it('gives every step a known kind, and text unless it is the closing link', () => {
    for (const step of DEMO_SCRIPT) {
      expect(['user', 'log', 'reply', 'coda']).toContain(step.kind);
      expect(step.text.length > 0 || Boolean(step.link)).toBe(true);
    }
  });
  it('opens on the visitor’s own message and closes on the way back to the record', () => {
    expect(DEMO_SCRIPT[0]).toEqual({ kind: 'user', text: DEMO_USER_MESSAGE });
    expect(DEMO_SCRIPT.at(-1)?.kind).toBe('coda');
    expect(DEMO_SCRIPT.at(-1)?.link?.internal).toBe(true);
  });
  it('has the agent reply to the visitor before the record closes it out', () => {
    const replyAt = DEMO_SCRIPT.findIndex((step) => step.kind === 'reply');
    expect(replyAt).toBeGreaterThan(0);
    expect(DEMO_SCRIPT[replyAt].text).toBe(DEMO_REPLY);
    expect(replyAt).toBeLessThan(DEMO_SCRIPT.length - 1);
  });
  it('runs the status log between the message and the reply, never after it', () => {
    const logSteps = DEMO_SCRIPT.filter((step) => step.kind === 'log');
    expect(logSteps.length).toBeGreaterThanOrEqual(4);
    const replyAt = DEMO_SCRIPT.findIndex((step) => step.kind === 'reply');
    expect(DEMO_SCRIPT.slice(1, replyAt).every((step) => step.kind === 'log')).toBe(true);
  });
  it('flags exactly the log line naming the SLA failure as the outcome, and marks where it goes', () => {
    const flagged = DEMO_SCRIPT.filter((step) => step.outcome);
    expect(flagged.length).toBe(1);
    expect(flagged[0].outcome).toBe('fail');
    expect(flagged[0].kind).toBe('log');
    expect(flagged[0].text).toContain('{outcome}');
  });

  // The link opens its line rather than trailing under it, so the label is
  // the first thing read: it has to name the record on the other side, not
  // describe the click.
  it('labels every log link as the record it opens, short enough to lead the line', () => {
    for (const step of DEMO_SCRIPT) {
      if (step.kind !== 'log' || !step.link) continue;
      expect(step.link.label.length).toBeLessThanOrEqual(24);
      expect(step.link.label).not.toMatch(/^(the|same|a) /i);
    }
  });
  it('links every step that carries one to a well-formed https url, or an in-app path when internal', () => {
    for (const step of DEMO_SCRIPT) {
      if (!step.link) continue;
      expect(step.link.href).toMatch(step.link.internal ? /^\// : HTTPS);
      expect(step.link.label.length).toBeGreaterThan(0);
    }
  });
  it('points the payment link at a real Base Sepolia transaction hash', () => {
    const payment = DEMO_SCRIPT.find((step) => step.link?.href.includes('basescan.org'));
    expect(payment).toBeTruthy();
    const hash = new URL(/** @type {string} */ (payment?.link?.href)).pathname.split('/').pop();
    expect(hash).toMatch(TX);
  });
  it('points the Arc links at the real verdict transaction, on the working explorer', () => {
    const arcLinks = DEMO_SCRIPT.filter((step) => step.link?.href.includes('arcscan.app')).map((step) => /** @type {string} */ (step.link?.href));
    expect(arcLinks.length).toBeGreaterThanOrEqual(2);
    expect(arcLinks.every((href) => TX.test(href.split('/').pop() ?? ''))).toBe(true);
    // web/.impeccable/surfaces/web-src-lit-app-js.md: explorer.testnet.arc.network
    // does not resolve. Nothing here should point at it.
    expect(arcLinks.every((href) => !href.includes('explorer.testnet.arc.network'))).toBe(true);
  });
  it('states what the call cost, how long it took, and what came back', () => {
    const log = DEMO_SCRIPT.filter((step) => step.kind === 'log').map((step) => step.text).join('\n');
    expect(log).toContain('{paid}');
    expect(log).toContain('{latency}');
    expect(log).toContain('{refunded}');
    expect(DEMO_VALUES).toEqual({ paid: DEMO_PAID, latency: DEMO_LATENCY, refunded: DEMO_REFUNDED });
  });

  // A token nothing resolves would ship to a visitor as `{paid}`, and a figure
  // spelled out raw would ship in the same grey as the words around it.
  it('quotes every figure through a token the renderer knows, and none it does not', () => {
    for (const step of DEMO_SCRIPT) {
      for (const [, key] of step.text.matchAll(/\{([a-z]+)\}/g)) {
        expect(key === 'host' || key === 'outcome' || key in DEMO_VALUES).toBe(true);
      }
      for (const value of Object.values(DEMO_VALUES)) expect(step.text).not.toContain(value);
    }
  });

  // docs/evidence/clause-detail-live.log §3: the judged call paid 2500 minor
  // units and was credited exactly that back, the cap binding at what was
  // paid. A refund larger than the payment would be the one number on this
  // page that contradicts the mechanism it is demonstrating.
  it('never shows a refund bigger than the payment', () => {
    const minorUnits = (/** @type {string} */ usdc) => Math.round(Number(usdc.replace(' USDC', '')) * 1e6);
    expect(minorUnits(DEMO_REFUNDED)).toBeLessThanOrEqual(minorUnits(DEMO_PAID));
  });

  // The Base Sepolia signature is a separate leg for a different amount
  // (1 minor unit, x402-payment-live.log). Attaching this flow's money
  // figures to it would print a total that never happened.
  it('attaches no money figure to the payment-signature line', () => {
    const signature = DEMO_SCRIPT.find((step) => step.link?.href.includes('basescan.org'));
    expect(signature).toBeTruthy();
    expect(`${signature?.link?.label} ${signature?.text}`).not.toMatch(/[\d.]+\s*USDC/);
  });

  it('carries the charge into the agent’s own reply, as a value the renderer can set in mono', () => {
    const reply = /** @type {{text: string}} */ (DEMO_SCRIPT.find((step) => step.kind === 'reply'));
    expect(reply.text).toContain('{paid}');
    expect(DEMO_REPLY).toMatch(/refunded/i);
  });

  // One identifier, one treatment: the route is never spelled out raw in a
  // step's text, so it can't appear underlined in one line and bare in another.
  it('names the proxy route through the host token rather than spelling it out', () => {
    expect(DEMO_HOST).toBe(`${DEMO_SLUG}.verdikt.bond`);
    expect(DEMO_SCRIPT.some((step) => step.text.includes('{host}'))).toBe(true);
    for (const step of DEMO_SCRIPT) expect(step.text).not.toContain('.verdikt.bond');
  });

  // The log is the agent's own wiring and names the route it called; the reply
  // is what a person reads, and a hostname there is noise they can't act on.
  it('keeps the route out of the agent’s reply', () => {
    expect(DEMO_REPLY).not.toContain('{host}');
    expect(DEMO_REPLY).toMatch(/weather service/i);
  });

  it('closes on an in-app link to the demo service’s own page', () => {
    const last = DEMO_SCRIPT[DEMO_SCRIPT.length - 1];
    expect(last.link?.internal).toBe(true);
    expect(last.link?.href).toBe(DEMO_SERVICE_URL);
    expect(DEMO_SERVICE_URL).toBe(`/services/${DEMO_SLUG}`);
  });
});
