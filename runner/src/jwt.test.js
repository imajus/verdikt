import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addressOf, signPersonalMessage } from '@verdikt/sdk/signing';
import { verifyTriggerJwt, TriggerJwtError, TRIGGER_JWT_FAILURE } from './jwt.js';

const KEY = `0x${'11'.repeat(32)}`;
const OTHER_KEY = `0x${'22'.repeat(32)}`;
const ADDRESS = addressOf(KEY);
const NOW = 1_800_000_000;

const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 'req-123',
  method: 'workflows.execute',
  params: { input: { serviceId: '0x01' }, workflow: { workflowID: 'a'.repeat(64) } }
});

/** @param {object} obj */
const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** @param {string} b */
const digestOf = (b) => `0x${createHash('sha256').update(b, 'utf8').digest('hex')}`;

// A local, minimal re-implementation of proxy/src/jwt.js's mintTriggerJwt —
// deliberately not imported from the proxy package (runner has no dependency
// on @verdikt/proxy, matching the package-boundary rule this file's
// implementation follows). Kept intentionally tiny; it only needs to produce
// tokens shaped like the real one for these tests to exercise the verifier.
/** @param {{ payload?: object, key?: string }} [options] */
async function mint({ payload: payloadOverrides = {}, key = KEY } = {}) {
  const header = { alg: 'ETH', typ: 'JWT' };
  const payload = { digest: digestOf(body), iss: addressOf(key), iat: NOW, exp: NOW + 60, jti: 'jti-1', ...payloadOverrides };
  const headerSeg = base64url(header);
  const payloadSeg = base64url(payload);
  const signature = await signPersonalMessage(key, `${headerSeg}.${payloadSeg}`);
  const signatureSeg = Buffer.from(signature.slice(2), 'hex').toString('base64url');
  return `${headerSeg}.${payloadSeg}.${signatureSeg}`;
}

/** @param {string} token @param {Partial<Parameters<typeof verifyTriggerJwt>[0]>} [overrides] */
const verify = (token, overrides = {}) =>
  verifyTriggerJwt({
    authorization: `Bearer ${token}`,
    body,
    expectedSignerAddress: ADDRESS,
    now: NOW,
    ...overrides
  });

describe('verifyTriggerJwt', () => {
  it('accepts a well-formed token from the expected signer', async () => {
    const result = await verify(await mint());
    expect(result).toEqual({ issuer: ADDRESS, jti: 'jti-1' });
  });

  it('rejects a missing Authorization header', async () => {
    await expect(verifyTriggerJwt({ authorization: null, body, expectedSignerAddress: ADDRESS, now: NOW })).rejects.toMatchObject({
      failure: TRIGGER_JWT_FAILURE.MALFORMED
    });
  });

  it('rejects a non-Bearer header', async () => {
    await expect(
      verifyTriggerJwt({ authorization: 'Basic abc', body, expectedSignerAddress: ADDRESS, now: NOW })
    ).rejects.toBeInstanceOf(TriggerJwtError);
  });

  it('rejects a token with the wrong digest for this body', async () => {
    const token = await mint({ payload: { digest: digestOf('{"different":true}') } });
    await expect(verify(token)).rejects.toMatchObject({ failure: TRIGGER_JWT_FAILURE.DIGEST_MISMATCH });
  });

  it('rejects an expired token', async () => {
    const token = await mint({ payload: { iat: NOW - 120, exp: NOW - 60 } });
    await expect(verify(token)).rejects.toMatchObject({ failure: TRIGGER_JWT_FAILURE.EXPIRED });
  });

  it('rejects a token signed by a key other than the expected signer', async () => {
    const token = await mint({ key: OTHER_KEY, payload: { digest: digestOf(body) } });
    await expect(verify(token)).rejects.toMatchObject({ failure: TRIGGER_JWT_FAILURE.WRONG_SIGNER });
  });

  it('rejects a tampered signature', async () => {
    const token = await mint();
    const [h, p, s] = token.split('.');
    const flipped = Buffer.from(s, 'base64url');
    flipped[0] ^= 0xff;
    await expect(verify(`${h}.${p}.${flipped.toString('base64url')}`)).rejects.toMatchObject({
      failure: TRIGGER_JWT_FAILURE.BAD_SIGNATURE
    });
  });

  it('rejects a TTL longer than maxAgeSeconds', async () => {
    const token = await mint({ payload: { iat: NOW, exp: NOW + 600 } });
    await expect(verify(token, { maxAgeSeconds: 300 })).rejects.toMatchObject({ failure: TRIGGER_JWT_FAILURE.EXPIRED });
  });

  it('rejects a malformed token shape', async () => {
    await expect(verify('not-a-jwt')).rejects.toMatchObject({ failure: TRIGGER_JWT_FAILURE.MALFORMED });
  });
});
