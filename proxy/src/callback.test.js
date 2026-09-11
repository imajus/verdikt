import { describe, expect, it, vi } from 'vitest';
import { call } from './test-support.js';
import { loadConfig } from './config.js';
import { VERIFICATION_FAILURE, createPendingRegistry, createWorkflowClient } from './verification.js';
import { decodeTriggerJwt } from './jwt.js';

const TOKEN = 'a-shared-secret';
const REQUEST_ID = `0x${'ab'.repeat(32)}`;
const KEY = `0x${'11'.repeat(32)}`;

const config = loadConfig({
  PROXY_PUBLIC_HOST: 'verdikt.bond',
  VERDIKT_REGISTRY_ADDRESS: '0x01',
  CRE_CALLBACK_TOKEN: TOKEN
});

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {VerificationResult & { requestId: string }}
 */
const result = (overrides = {}) => ({
  requestId: REQUEST_ID,
  status: 200,
  body: '{"temp":12.5}',
  outcome: /** @type {SlaOutcome} */ ('PASS'),
  mode: /** @type {JudgementMode} */ ('sla'),
  reason: null,
  clauses: [],
  headers: {},
  tx: `0x${'cd'.repeat(32)}`,
  ...overrides
});

/** @param {{ token?: string|null }} [options] */
function harness({ token = TOKEN } = {}) {
  const pending = createPendingRegistry();
  const deps = /** @type {ProxyDeps} */ ({
    config: { ...config, callbackToken: token ?? undefined },
    registry: { getService: async () => ({ provider: '0x0', status: 'ACTIVE', deposit: 0n }) },
    resolveServiceRecord: async () => {
      throw new Error('unused');
    },
    workflow: { pending, verify: async () => result() }
  });
  /**
   * @param {unknown} body
   * @param {Record<string, string>} [headers]
   */
  const post = (body, headers = { authorization: `Bearer ${TOKEN}` }) =>
    call(deps, {
      method: 'POST',
      url: '/internal/verification-callback',
      headers: { 'content-type': 'application/json', ...headers },
      payload: body
    });
  return { deps, pending, post };
}

describe('the verification callback', () => {
  it('hands a pushed result to the request waiting on it', async () => {
    const { pending, post } = harness();
    const waiting = pending.await(REQUEST_ID, 5_000);

    expect((await post(result())).statusCode).toBe(200);
    await expect(waiting).resolves.toMatchObject({ outcome: 'PASS', status: 200, body: '{"temp":12.5}' });
  });

  // Forging a callback would put attacker-chosen bytes in front of a paying
  // agent. It could not fake the on-chain verdict — the DON signs that — but
  // the agent would still be handed the wrong response.
  it('refuses a callback with no bearer, a wrong bearer, or a wrong scheme', async () => {
    const { post } = harness();
    /** @type {Record<string, string>[]} */
    const headerSets = [{}, { authorization: 'Bearer nope' }, { authorization: `Basic ${TOKEN}` }];
    for (const headers of headerSets) {
      expect((await post(result(), headers)).statusCode, JSON.stringify(headers)).toBe(401);
    }
  });

  it('refuses every callback when no token is configured', async () => {
    // The safe direction: a paid call times out rather than being answered by
    // anyone who can reach the port. `null`, not `undefined` — the latter would
    // trip the harness's default parameter and quietly re-enable the token.
    const { post } = harness({ token: null });
    expect((await post(result())).statusCode).toBe(401);
  });

  it('rejects a result nobody is waiting for', async () => {
    // Already answered, timed out, or never issued by this process.
    const { post } = harness();
    const response = await post(result({ requestId: `0x${'ff'.repeat(32)}` }));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('no_such_pending_request');
  });

  it('accepts a given requestId only once', async () => {
    const { pending, post } = harness();
    const waiting = pending.await(REQUEST_ID, 5_000);
    expect((await post(result())).statusCode).toBe(200);
    await waiting;
    expect((await post(result())).statusCode).toBe(409);
  });

  it('rejects a malformed body without disturbing the waiter', async () => {
    const { pending, post } = harness();
    const waiting = pending.await(REQUEST_ID, 5_000);
    expect((await post('{not json')).statusCode).toBe(400);
    expect((await post({ status: 200 })).statusCode).toBe(400);
    expect(pending.size).toBe(1);
    pending.settle(REQUEST_ID, result());
    await waiting;
  });

  it('is matched ahead of the service catch-all, not read as a slug', async () => {
    const { post } = harness();
    // A 401 rather than a 404 or a proxy attempt proves the exact route won.
    expect((await post(result(), {})).statusCode).toBe(401);
  });
});

describe('the pending registry', () => {
  it('times out rather than waiting forever, and says so distinctly', async () => {
    const pending = createPendingRegistry();
    await expect(pending.await(REQUEST_ID, 5)).rejects.toMatchObject({
      failure: VERIFICATION_FAILURE.TIMEOUT
    });
    expect(pending.size).toBe(0);
  });

  it('forgets a waiter once settled, so nothing leaks per request', async () => {
    const pending = createPendingRegistry();
    const waiting = pending.await(REQUEST_ID, 5_000);
    expect(pending.size).toBe(1);
    pending.settle(REQUEST_ID, result());
    await waiting;
    expect(pending.size).toBe(0);
  });

  it('reports whether anyone was actually waiting', () => {
    const pending = createPendingRegistry();
    expect(pending.settle(REQUEST_ID, result())).toBe(false);
    expect(pending.cancel(REQUEST_ID, new Error('x'))).toBe(false);
  });
});

describe('the trigger request', () => {
  /**
   * @param {Response} response
   * @param {{ url: string, init: RequestInit }[]} [calls]
   */
  const clientWith = (response, calls = []) =>
    createWorkflowClient({
      triggerUrl: 'https://gateway.test/rpc',
      workflowId: 'a'.repeat(64),
      privateKey: KEY,
      callbackUrl: 'http://proxy.test/internal/verification-callback',
      timeoutMs: 200,
      fetch: /** @type {typeof fetch} */ (
        /** @type {unknown} */ (
          vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
            calls.push({ url, init });
            return response;
          })
        )
      )
    });

  const accepted = () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { status: 'ACCEPTED' } }), { status: 200 });

  /** @returns {VerificationRequest} */
  const request = () => ({
    serviceId: '0x01',
    requestId: REQUEST_ID,
    providerUrl: 'https://provider.example/x',
    method: 'GET',
    paymentHeader: 'abc',
    paymentHeaderName: 'x-payment',
    bodyHex: null,
    contentType: null,
    payer: '0x1111111111111111111111111111111111111111',
    paidAmountMinorUnits: '2500',
    sla: null
  });

  it('sends the JSON-RPC shape the gateway documents', async () => {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    const client = clientWith(accepted(), calls);
    const verifying = client.verify(request());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'workflows.execute',
      params: { workflow: { workflowID: 'a'.repeat(64) } }
    });
    expect(body.params.input.callbackUrl).toBe('http://proxy.test/internal/verification-callback');

    client.pending?.settle(REQUEST_ID, result());
    await verifying;
  });

  it('signs a JWT digesting that exact body', async () => {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    const client = clientWith(accepted(), calls);
    const verifying = client.verify(request());
    await new Promise((resolve) => setTimeout(resolve, 10));

    const sent = String(calls[0].init.body);
    const sentHeaders = /** @type {Record<string,string>} */ (calls[0].init.headers);
    const bearer = String(sentHeaders.authorization).replace('Bearer ', '');
    const { payload } = decodeTriggerJwt(bearer);
    const { digestOf } = await import('./jwt.js');
    expect(payload.digest).toBe(digestOf(sent));

    client.pending?.settle(REQUEST_ID, result());
    await verifying;
  });

  it('fails fast when the gateway refuses, instead of waiting for a callback that will never come', async () => {
    const client = clientWith(new Response('nope', { status: 401 }));
    await expect(client.verify(request())).rejects.toMatchObject({
      failure: VERIFICATION_FAILURE.TRIGGER_REJECTED
    });
    expect(client.pending?.size).toBe(0);
  });

  it('treats a JSON-RPC error as a refusal even on HTTP 200', async () => {
    const client = clientWith(
      new Response(JSON.stringify({ jsonrpc: '2.0', error: { message: 'unauthorized key' } }), { status: 200 })
    );
    await expect(client.verify(request())).rejects.toThrow(/unauthorized key/);
  });

  it('times out when the trigger is accepted but no callback arrives', async () => {
    const client = clientWith(accepted());
    await expect(client.verify(request())).rejects.toMatchObject({ failure: VERIFICATION_FAILURE.TIMEOUT });
  });
});
