import { describe, expect, it } from 'vitest';
import { disclosureMessage, DISCLOSURE_PREFIX } from './claim.mjs';
import { disclosureMessage as proxyDisclosureMessage } from '../proxy/src/evidence.js';

const REQUEST_ID = `0x${'ab'.repeat(32)}`;

// These exact bytes now live in three places: proxy/src/evidence.js,
// genlayer/scripts/claim.py and scripts/claim.mjs. A drift in any one makes
// every disclosure refuse, which reads as a claimant error rather than as the
// bug it is — so the copies are pinned to each other.
describe('the disclosure message', () => {
  it('is the prefix the proxy documents', () => {
    expect(DISCLOSURE_PREFIX).toBe('Verdikt evidence disclosure\nrequest: ');
  });

  it('matches the proxy byte for byte', () => {
    expect(disclosureMessage(REQUEST_ID)).toBe(proxyDisclosureMessage(REQUEST_ID));
  });

  // The judge stores the id lowercased, and a signature over the checksummed
  // form would recover the right key against the wrong message.
  it('lowercases the request id, as the proxy does', () => {
    expect(disclosureMessage(REQUEST_ID.toUpperCase().replace('0X', '0x'))).toBe(
      `${DISCLOSURE_PREFIX}${REQUEST_ID}`
    );
  });
});
