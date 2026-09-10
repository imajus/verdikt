import { describe, expect, it, vi } from 'vitest';
import { addressOf, signPersonalMessage } from '@verdikt/sdk/signing';
import { createHash } from 'node:crypto';
import { handleTrigger } from './gateway.js';

const KEY = `0x${'11'.repeat(32)}`;
const ADDRESS = addressOf(KEY);
const NOW = 1_800_000_000;

const baseConfig = {
  triggerAddress: ADDRESS,
  jwtMaxAgeSeconds: 300,
  simulatorUrl: 'http://127.0.0.1:2000/trigger',
  triggerAckTimeoutMs: 5000,
  expectedWorkflowId: undefined
};

/** @param {string} b */
const digestOf = (b) => `0x${createHash('sha256').update(b, 'utf8').digest('hex')}`;
/** @param {object} obj */
const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** @param {string} body @param {{ key?: string, now?: number }} [options] */
async function mintFor(body, { key = KEY, now = NOW } = {}) {
  const header = { alg: 'ETH', typ: 'JWT' };
  const payload = { digest: digestOf(body), iss: addressOf(key), iat: now, exp: now + 60, jti: 'jti-1' };
  const headerSeg = base64url(header);
  const payloadSeg = base64url(payload);
  const signature = await signPersonalMessage(key, `${headerSeg}.${payloadSeg}`);
  const signatureSeg = Buffer.from(signature.slice(2), 'hex').toString('base64url');
  return `${headerSeg}.${payloadSeg}.${signatureSeg}`;
}

/** @param {Parameters<typeof handleTrigger>[0]} options */
const handle = (options) => handleTrigger({ now: NOW, ...options });

function envelope(overrides = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'req-123',
    method: 'workflows.execute',
    params: {
      input: { serviceId: '0x01', requestId: 'req-123', callbackUrl: 'https://proxy.example/internal/verification-callback' },
      workflow: { workflowID: 'a'.repeat(64) }
    },
    ...overrides
  });
}

describe('handleTrigger', () => {
  it('forwards an authenticated trigger and answers ACCEPTED', async () => {
    const rawBody = envelope();
    const authorization = `Bearer ${await mintFor(rawBody)}`;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    const { status, body } = await handle({ authorization, rawBody, config: baseConfig, fetchImpl });

    expect(status).toBe(200);
    expect(body.result.status).toBe('ACCEPTED');
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe('req-123');
    expect(fetchImpl).toHaveBeenCalledWith(
      baseConfig.simulatorUrl,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ input: JSON.parse(rawBody).params.input }) })
    );
  });

  it('accepts when the simulator forward times out (still running)', async () => {
    const rawBody = envelope();
    const authorization = `Bearer ${await mintFor(rawBody)}`;
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

    const { status, body } = await handle({ authorization, rawBody, config: baseConfig, fetchImpl });

    expect(status).toBe(200);
    expect(body.result.status).toBe('ACCEPTED');
  });

  it('rejects when the simulator is unreachable', async () => {
    const rawBody = envelope();
    const authorization = `Bearer ${await mintFor(rawBody)}`;
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const { status, body } = await handle({ authorization, rawBody, config: baseConfig, fetchImpl });

    expect(status).toBe(502);
    expect(body.error.message).toMatch(/could not reach the simulator/);
  });

  it('rejects an unauthenticated request without forwarding it', async () => {
    const rawBody = envelope();
    const fetchImpl = vi.fn();

    const { status, body } = await handle({ authorization: null, rawBody, config: baseConfig, fetchImpl });

    expect(status).toBe(401);
    expect(body.error).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a token whose digest does not match this body', async () => {
    const rawBody = envelope();
    const authorization = `Bearer ${await mintFor(envelope({ id: 'tampered' }))}`;
    const fetchImpl = vi.fn();

    const { status } = await handle({ authorization, rawBody, config: baseConfig, fetchImpl });

    expect(status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unsupported method', async () => {
    const rawBody = envelope({ method: 'workflows.cancel' });
    const authorization = `Bearer ${await mintFor(rawBody)}`;

    const { status, body } = await handle({ authorization, rawBody, config: baseConfig, fetchImpl: vi.fn() });

    expect(status).toBe(404);
    expect(body.error.message).toMatch(/unsupported method/);
  });

  it('rejects a workflowID that does not match this host', async () => {
    const rawBody = envelope();
    const authorization = `Bearer ${await mintFor(rawBody)}`;
    const config = { ...baseConfig, expectedWorkflowId: 'b'.repeat(64) };

    const { status, body } = await handle({ authorization, rawBody, config, fetchImpl: vi.fn() });

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/does not match/);
  });

  it('rejects malformed JSON', async () => {
    const { status, body } = await handle({
      authorization: 'Bearer whatever',
      rawBody: '{not json',
      config: baseConfig,
      fetchImpl: vi.fn()
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe(-32700);
  });
});
