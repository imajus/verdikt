import { describe, expect, it } from 'vitest';
import { MAX_RELAY_BODY_CHARS, relayPayload } from './relay.js';

describe('relayPayload', () => {
  // The regression this exists for. The workflow built the relay from status
  // and body alone, so `VerificationResult.headers` was `{}` on every real paid
  // call and the evidence envelope labelled every response `contentType: null`.
  // Nothing failed: the proxy relayed the payload as before, and the only
  // symptom was `SlaClaimJudge` refusing an unsupported content type — every
  // semantic claim resolving UNDETERMINED against evidence that was fine.
  it('carries the provider content type, which is what makes evidence judgeable', () => {
    expect(relayPayload({ status: 200, contentType: 'application/json', bodyText: '{}' }).headers).toEqual({
      'content-type': 'application/json'
    });
  });

  it('carries the parameters alongside the type, because a charset changes how a body decodes', () => {
    const relay = relayPayload({ status: 200, contentType: 'text/plain; charset=utf-8', bodyText: 'hi' });
    expect(relay.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  // Relaying these would describe the response wrongly rather than incompletely:
  // both count bytes that no longer exist once the enclave has decoded and
  // possibly clipped the body.
  it('relays no header at all when the provider declared no type', () => {
    expect(relayPayload({ status: 200, bodyText: 'hi' }).headers).toEqual({});
  });

  it('keeps a whole body whole, and says so', () => {
    const relay = relayPayload({ status: 200, contentType: 'text/plain', bodyText: 'hi' });
    expect(relay.body).toBe('hi');
    expect(relay.bodyTruncated).toBe(false);
  });

  it('clips an oversized body and flags it, so the agent can tell it holds part of one', () => {
    const relay = relayPayload({ status: 200, contentType: 'text/plain', bodyText: 'x'.repeat(MAX_RELAY_BODY_CHARS + 1) });
    expect(relay.body).toHaveLength(MAX_RELAY_BODY_CHARS);
    expect(relay.bodyTruncated).toBe(true);
  });

  it('does not flag a body that lands exactly on the cap', () => {
    const relay = relayPayload({ status: 200, contentType: 'text/plain', bodyText: 'x'.repeat(MAX_RELAY_BODY_CHARS) });
    expect(relay.bodyTruncated).toBe(false);
  });

  // The transport-failure path: no status, no headers, no body. The agent still
  // gets a response, and `evaluate` has already scored the provider DOWN.
  it('survives a call that never returned', () => {
    expect(relayPayload({ status: null })).toEqual({ status: null, headers: {}, body: '', bodyTruncated: false });
  });
});
