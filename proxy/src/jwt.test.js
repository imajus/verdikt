import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addressOf, verifyPersonalMessage } from '@verdikt/sdk/signing';
import { MAX_TTL_SECONDS, decodeTriggerJwt, digestOf, mintTriggerJwt } from './jwt.js';

const KEY = `0x${'11'.repeat(32)}`;
const ADDRESS = addressOf(KEY);
const NOW = 1_800_000_000;
const JTI = '550e8400-e29b-41d4-a716-446655440000';

const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 'req-123',
  method: 'workflows.execute',
  params: { input: { serviceId: '0x01' }, workflow: { workflowID: 'a'.repeat(64) } }
});

const mint = (overrides = {}) => mintTriggerJwt({ body, privateKey: KEY, now: NOW, jti: JTI, ...overrides });

describe('digestOf', () => {
  it('is the 0x-prefixed SHA256 of the exact body string', () => {
    expect(digestOf(body)).toBe(`0x${createHash('sha256').update(body, 'utf8').digest('hex')}`);
  });

  it('changes with a single byte', () => {
    expect(digestOf('{"a":1}')).not.toBe(digestOf('{"a":2}'));
  });
});

describe('mintTriggerJwt', () => {
  it('produces the header the gateway expects', async () => {
    expect(decodeTriggerJwt(await mint()).header).toEqual({ alg: 'ETH', typ: 'JWT' });
  });

  it('carries the five documented claims', async () => {
    expect(decodeTriggerJwt(await mint()).payload).toEqual({
      digest: digestOf(body),
      iss: ADDRESS,
      iat: NOW,
      exp: NOW + 60,
      jti: JTI
    });
  });

  // The whole reason this cannot be a static token in a config file: the
  // credential is bound to the bytes being sent.
  it('binds the token to the exact body', async () => {
    const other = await mintTriggerJwt({ body: `${body} `, privateKey: KEY, now: NOW, jti: JTI });
    expect(decodeTriggerJwt(other).payload.digest).not.toBe(digestOf(body));
    expect(other).not.toBe(await mint());
  });

  it('signs the two segments joined by a dot, recoverable to the issuer', async () => {
    // This is what the gateway does to authorise the call, so it is worth
    // checking against a real recovery rather than trusting the shape.
    const { signature, signedMessage, payload } = decodeTriggerJwt(await mint());
    expect(await verifyPersonalMessage(payload.iss, signedMessage, signature)).toBe(true);
  });

  it('emits a 65-byte r||s||v signature', async () => {
    expect(decodeTriggerJwt(await mint()).signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('refuses a lifetime the gateway would reject', async () => {
    await expect(mint({ ttlSeconds: MAX_TTL_SECONDS + 1 })).rejects.toThrow(/ttlSeconds/);
    await expect(mint({ ttlSeconds: 0 })).rejects.toThrow(/ttlSeconds/);
  });

  it('defaults to a lifetime well inside the cap', async () => {
    const { payload } = decodeTriggerJwt(await mint());
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it('uses a fresh jti per call, for replay protection', async () => {
    const a = decodeTriggerJwt(await mintTriggerJwt({ body, privateKey: KEY, now: NOW }));
    const b = decodeTriggerJwt(await mintTriggerJwt({ body, privateKey: KEY, now: NOW }));
    expect(a.payload.jti).not.toBe(b.payload.jti);
  });

  it('refuses to sign nothing', async () => {
    await expect(mintTriggerJwt({ body: '', privateKey: KEY })).rejects.toThrow(/body/);
  });
});
