import { describe, expect, it, vi } from 'vitest';
import { SERVICE_RECORD, SLA_TEXT } from '@verdikt/fixtures';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { VERIFICATION_FAILURE, VerificationError, parseWorkflowResult } from './verification.js';

const config = loadConfig({ PROXY_PUBLIC_HOST: 'verdikt.bond', VERDIKT_REGISTRY_ADDRESS: '0x01' });
const REQUEST_ID = `0x${'ab'.repeat(32)}`;
const PAYER = '0x1111111111111111111111111111111111111111';

/** @param {Partial<VerificationResult>} [overrides] @returns {VerificationResult} */
const verdict = (overrides = {}) => ({
  outcome: 'PASS',
  mode: 'sla',
  reason: null,
  clauses: [],
  tx: `0x${'cd'.repeat(32)}`,
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"current":{"temperature_2m":12.5}}',
  ...overrides
});

/**
 * @param {object} [options]
 * @param {VerificationResult|Error} [options.result]
 * @param {boolean} [options.noWorkflow]
 * @param {Error} [options.paymentError]
 */
function harness({ result, noWorkflow = false, paymentError } = {}) {
  const verify = vi.fn(async (/** @type {VerificationRequest} */ _request) => {
    if (result instanceof Error) throw result;
    return result ?? verdict();
  });
  const app = buildApp({
    config,
    resolveServiceRecord: async () => ({
      ...SERVICE_RECORD,
      address: '0x2222222222222222222222222222222222222222',
      url: 'https://provider.example/weather',
      sla: SLA_TEXT.honest
    }),
    registry: { getService: async () => ({ provider: '0x03', status: 'ACTIVE', deposit: 10n ** 19n }) },
    decodePayment: async () => {
      if (paymentError) throw paymentError;
      return { payer: PAYER, amount: 2500n };
    },
    workflow: noWorkflow ? null : { verify },
    newRequestId: () => REQUEST_ID
  });
  return { app, verify };
}

/** @param {import('fastify').FastifyInstance} app */
const paidCall = (app) =>
  app.inject({
    method: 'GET',
    url: '/weather/current?lat=52',
    headers: { host: 'proxy.local', 'x-payment': 'eyJzY2hlbWUiOiJHYXRld2F5V2FsbGV0QmF0Y2hlZCJ9' }
  });

describe('the verified branch — the happy path', () => {
  it('relays the provider’s payload with the verdict attached', async () => {
    const { app } = harness();
    const response = await paidCall(app);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"current":{"temperature_2m":12.5}}');
    expect(response.headers['x-verdikt-verdict']).toBe('PASS');
    expect(response.headers['x-verdikt-request-id']).toBe(REQUEST_ID);
    expect(response.headers['x-verdikt-tx']).toMatch(/^0x/);
  });

  it('hands the enclave the SLA it resolved, so the workflow never touches ENS', async () => {
    const { app, verify } = harness();
    await paidCall(app);
    const sent = verify.mock.lastCall?.[0];
    expect(sent?.sla).toBe(SLA_TEXT.honest);
    expect(sent?.payer).toBe(PAYER);
    expect(sent?.paidAmountMinorUnits).toBe('2500');
    expect(sent?.providerUrl).toBe('https://provider.example/weather/current?lat=52');
  });

  it('never sees the response body except to relay it', async () => {
    // The proxy has no dependency on @verdikt/sla; if it needed one, something
    // would have moved to the wrong side of the enclave boundary.
    const packageJson = await import('../package.json', { with: { type: 'json' } });
    expect(Object.keys(packageJson.default.dependencies ?? {})).not.toContain('@verdikt/sla');
  });
});

describe('the verified branch — outcomes that are not PASS', () => {
  it('relays a FAIL response with the verdict and the failing clause detail', async () => {
    const { app } = harness({
      result: verdict({
        outcome: 'FAIL',
        status: 200,
        clauses: [{ id: 'speed', type: 'latency', pass: false, expected: '<= 5000ms', actual: '9000ms' }]
      })
    });
    const response = await paidCall(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-verdikt-verdict']).toBe('FAIL');
  });

  it('relays a provider 5xx as a 5xx rather than dressing it up as a proxy error', async () => {
    // It is an SLA failure the engine has already judged; rewriting it would
    // hide from the agent what it actually bought.
    const { app } = harness({ result: verdict({ outcome: 'FAIL', status: 503, body: 'upstream down' }) });
    const response = await paidCall(app);
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('upstream down');
    expect(response.headers['x-verdikt-verdict']).toBe('FAIL');
  });

  it('reports NONE when the fallback declined to write a verdict, and still delivers', async () => {
    // No verdict is not the same as no delivery: the agent paid for the 4xx.
    const { app } = harness({
      result: verdict({ outcome: null, mode: 'status-only', reason: 'sla record unreadable', status: 404, tx: null })
    });
    const response = await paidCall(app);
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-verdikt-verdict']).toBe('NONE');
    expect(response.headers['x-verdikt-fallback-reason']).toBe('sla record unreadable');
  });

  it('flags a truncated payload rather than letting it look complete', async () => {
    const { app } = harness({ result: verdict({ bodyTruncated: true }) });
    expect((await paidCall(app)).headers['x-verdikt-body-truncated']).toBe('true');
  });
});

describe('the verified branch — failure modes (Tasks.md 4.4)', () => {
  it('still relays the payload when the Arc write missed, and flags it', async () => {
    // The agent paid for the response; the verdict can be rewritten, the
    // response cannot be refetched — an x402 payment settles once.
    const { app } = harness({ result: verdict({ tx: null }) });
    const response = await paidCall(app);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"current":{"temperature_2m":12.5}}');
    expect(response.headers['x-verdikt-verdict-unwritten']).toBe('true');
    expect(response.headers['x-verdikt-tx']).toBeUndefined();
  });

  it('surfaces a workflow timeout distinctly, never silently', async () => {
    const { app } = harness({
      result: new VerificationError(VERIFICATION_FAILURE.TIMEOUT, 'no result within 45000ms')
    });
    const response = await paidCall(app);
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: 'workflow_timeout', paid: true, requestId: REQUEST_ID });
  });

  it('surfaces a rejected trigger as its own failure', async () => {
    const { app } = harness({
      result: new VerificationError(VERIFICATION_FAILURE.TRIGGER_REJECTED, 'gateway returned 401')
    });
    const response = await paidCall(app);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('trigger_rejected');
  });

  it('names the requestId on every failure, so a paying agent has something to quote', async () => {
    const { app } = harness({ result: new Error('something unexpected') });
    const response = await paidCall(app);
    expect(response.headers['x-verdikt-request-id']).toBe(REQUEST_ID);
    expect(response.json().requestId).toBe(REQUEST_ID);
  });

  it('refuses to verify at all when it cannot decode the payment', async () => {
    // Every refund targets the payer this returns, so guessing is not an option.
    const { app, verify } = harness({ paymentError: new Error('NOT_IMPLEMENTED (Spike C)') });
    const response = await paidCall(app);
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe('payment_undecodable');
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses a paid call when no workflow is configured, rather than relaying it unverified', async () => {
    const { app } = harness({ noWorkflow: true });
    const response = await paidCall(app);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('verification_unavailable');
  });

  it('does not take the paid branch for an empty X-PAYMENT header', async () => {
    const { app, verify } = harness();
    await app.inject({ method: 'GET', url: '/weather/current', headers: { host: 'proxy.local', 'x-payment': '' } });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('parseWorkflowResult', () => {
  it('accepts the JSON string the workflow returns', () => {
    const result = parseWorkflowResult(JSON.stringify(verdict()));
    expect(result).toMatchObject({ outcome: 'PASS', status: 200, body: '{"current":{"temperature_2m":12.5}}' });
  });

  it('defaults a missing outcome to null rather than inventing a PASS', () => {
    expect(parseWorkflowResult('{"mode":"status-only","status":404}').outcome).toBeNull();
  });

  it('refuses a result it cannot read', () => {
    expect(() => parseWorkflowResult('null')).toThrow();
  });
});
