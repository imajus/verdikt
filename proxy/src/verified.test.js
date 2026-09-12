import { describe, expect, it, vi } from 'vitest';
import { SERVICE_RECORD, SLA_TEXT } from '@verdikt/fixtures';
import { call } from './test-support.js';
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

const CHALLENGE_ACCEPTS = [{ scheme: 'exact', network: 'eip155:84532', extra: { name: 'USDC', version: '2' } }];

/**
 * @param {object} [options]
 * @param {VerificationResult|Error} [options.result]
 * @param {boolean} [options.noWorkflow]
 * @param {Error} [options.paymentError]
 * @param {Response|(() => Response|Promise<Response>)} [options.upstream] what the provider answers the
 *   accepts-probe with. Defaults to a 402 carrying `CHALLENGE_ACCEPTS`, since the verified branch now
 *   fetches this on every paid call (see 'the accepts wiring' below) — a test that cares only about the
 *   workflow outcome should not have to know that.
 * @param {ProxyConfig} [options.config] overrides the default, for the tests that care which
 *   payment-chain RPCs are configured.
 */
function harness({ result, noWorkflow = false, paymentError, upstream, config: configOverride = config } = {}) {
  const verify = vi.fn(async (/** @type {VerificationRequest} */ _request) => {
    if (result instanceof Error) throw result;
    return result ?? verdict();
  });
  // Params are declared, unused as they are, so `mock.lastCall` stays a typed
  // 2-tuple — the reader wiring is asserted off its second argument.
  const decodePayment = vi.fn(
    async (
      /** @type {string} */ _header,
      /** @type {{ accepts: unknown[], ethCall?: EthCall }} */ _options
    ) => {
      if (paymentError) throw paymentError;
      return { payer: PAYER, amount: 2500n };
    }
  );
  const upstreamFetch = vi.fn(async (/** @type {URL|string} */ _url, /** @type {RequestInit} */ _init) =>
    typeof upstream === 'function'
      ? upstream()
      : (upstream ?? new Response(JSON.stringify({ accepts: CHALLENGE_ACCEPTS }), { status: 402 }))
  );
  const deps = /** @type {ProxyDeps} */ ({
    config: configOverride,
    resolveServiceRecord: async () => ({
      ...SERVICE_RECORD,
      address: '0x2222222222222222222222222222222222222222',
      url: 'https://provider.example/weather',
      sla: SLA_TEXT.honest
    }),
    registry: { getService: async () => ({ provider: '0x03', status: 'ACTIVE', deposit: 10n ** 19n }) },
    decodePayment,
    workflow: noWorkflow ? null : { verify },
    newRequestId: () => REQUEST_ID,
    fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (upstreamFetch))
  });
  return { deps, verify, decodePayment, upstreamFetch };
}

/** @param {ProxyDeps} deps */
const paidCall = (deps) =>
  call(deps, {
    method: 'GET',
    url: '/weather/current?lat=52',
    headers: { host: 'proxy.local', 'x-payment': 'eyJzY2hlbWUiOiJHYXRld2F5V2FsbGV0QmF0Y2hlZCJ9' }
  });

describe('the verified branch — the agent’s request body', () => {
  const BODY = { addresses: [{ address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', networks: ['base-mainnet'] }] };

  /** @param {ProxyDeps} deps */
  const paidPost = (deps) =>
    call(deps, {
      method: 'POST',
      url: '/weather/current',
      headers: {
        host: 'proxy.local',
        'content-type': 'application/json',
        'x-payment': 'eyJzY2hlbWUiOiJHYXRld2F5V2FsbGV0QmF0Y2hlZCJ9'
      },
      payload: BODY
    });

  // The enclave's replay IS the paid call — an x402 payment settles once, so a
  // body that does not reach the trigger never reaches the provider on any
  // other leg. This shipped broken: every POST service saw an empty request and
  // answered 4xx, and the 4xx invariant then correctly declined to score it as
  // the provider's fault, so the agent paid and no verdict was written. Two
  // live calls to portfolio.verdikt.bond burned $0.001 each proving it.
  it('travels to the enclave hex-encoded, with its content type', async () => {
    const { deps, verify } = harness();
    await paidPost(deps);
    const sent = verify.mock.lastCall?.[0];

    expect(sent?.contentType).toBe('application/json');
    expect(Buffer.from(String(sent?.bodyHex).slice(2), 'hex').toString()).toBe(JSON.stringify(BODY));
  });

  it('is null for a GET, so the replay sends nothing the agent did not', async () => {
    const { deps, verify } = harness();
    await paidCall(deps);
    expect(verify.mock.lastCall?.[0]?.bodyHex).toBeNull();
  });
});

describe('the verified branch — the happy path', () => {
  it('relays the provider’s payload with the verdict attached', async () => {
    const { deps } = harness();
    const response = await paidCall(deps);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"current":{"temperature_2m":12.5}}');
    expect(response.headers['x-verdikt-verdict']).toBe('PASS');
    expect(response.headers['x-verdikt-request-id']).toBe(REQUEST_ID);
    expect(response.headers['x-verdikt-tx']).toMatch(/^0x/);
  });

  it('hands the enclave the SLA it resolved, so the workflow never touches ENS', async () => {
    const { deps, verify } = harness();
    await paidCall(deps);
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

describe('the verified branch — the accepts wiring', () => {
  // decodePayment refuses without the challenge's own `accepts` array — it is
  // the only place the EIP-712 domain (asset, name, version) lives, and the
  // X-PAYMENT header names only scheme and network (packages/sdk/payment.js).
  // This reproduces a production incident: every real paid call to
  // weather.verdikt.bond 500'd with `payment_undecodable`, "no accepts
  // supplied", before ever reaching the workflow trigger.
  it('fetches the provider’s challenge and hands decodePayment its accepts array', async () => {
    const { deps, decodePayment, upstreamFetch } = harness();
    await paidCall(deps);

    expect(decodePayment).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accepts: CHALLENGE_ACCEPTS }));
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(String(upstreamFetch.mock.calls[0][0])).toBe('https://provider.example/weather/current?lat=52');
  });

  it('does not forward X-PAYMENT on the accepts probe, so it cannot itself settle the payment', async () => {
    const { deps, upstreamFetch } = harness();
    await paidCall(deps);

    const [, init] = upstreamFetch.mock.calls[0];
    const headers = /** @type {Record<string,string>} */ (init.headers);
    expect(headers['x-payment']).toBeUndefined();
  });

  it('surfaces a challenge fetch failure distinctly, rather than as an unrelated decode error', async () => {
    const { deps } = harness({
      upstream: () => {
        throw new Error('connect timed out');
      }
    });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('challenge_unavailable');
  });
});

describe('the verified branch — x402 v2’s payment-signature header', () => {
  // Reproduces a production incident: a real paid call to portfolio.verdikt.bond
  // (Circle's CLI, against Alchemy's x402 v2 endpoint) settled and delivered
  // data but wrote no verdict, because the proxy looked for `x-payment` only.
  // Confirmed live by tailing the proxy: the paid request carried
  // `payment-signature` and no `x-payment` at all.
  it('takes the paid branch on a v2 `payment-signature` header, with no `x-payment` present', async () => {
    const { deps, verify } = harness();
    const response = await call(deps, {
      method: 'GET',
      url: '/weather/current?lat=52',
      headers: { host: 'proxy.local', 'payment-signature': 'eyJzY2hlbWUiOiJHYXRld2F5V2FsbGV0QmF0Y2hlZCJ9' }
    });
    expect(verify).toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
  });

  it('prefers `payment-signature` over `x-payment` when a caller somehow sends both', async () => {
    const { deps, decodePayment } = harness();
    await call(deps, {
      method: 'GET',
      url: '/weather/current?lat=52',
      headers: { host: 'proxy.local', 'payment-signature': 'v2-header', 'x-payment': 'v1-header' }
    });
    expect(decodePayment).toHaveBeenCalledWith('v2-header', expect.anything());
  });

  it('strips both payment header names from the accepts probe, so neither can settle the payment a second time', async () => {
    const { deps, upstreamFetch } = harness();
    await call(deps, {
      method: 'GET',
      url: '/weather/current?lat=52',
      headers: { host: 'proxy.local', 'payment-signature': 'v2-header' }
    });
    const [, init] = upstreamFetch.mock.calls[0];
    const headers = /** @type {Record<string,string>} */ (init.headers);
    expect(headers['payment-signature']).toBeUndefined();
    expect(headers['x-payment']).toBeUndefined();
  });

  // A Circle agent wallet pays as a deployed smart-contract account: the
  // signature is made by an owner key and validated by the account itself, so
  // `decodePayment` can only settle it by asking the account (ERC-1271). That
  // ask is an `eth_call` on the *payment's* chain — whichever chain the
  // provider's 402 named, routinely neither of Verdikt's own two — so the
  // proxy hands down a reader built from the `PAYMENT_<NAME>_RPC_URL` vars. Live, this was
  // the whole of a `payment_undecodable` 500 on a call the agent had paid for.
  describe('the reader it gives decodePayment for a contract-account payer', () => {
    const withRpc = loadConfig({
      PROXY_PUBLIC_HOST: 'verdikt.bond',
      VERDIKT_REGISTRY_ADDRESS: '0x01',
      PAYMENT_BASE_RPC_URL: 'https://base.example/rpc'
    });
    const MAGIC_WORD = `0x1626ba7e${'00'.repeat(28)}`;

    it('calls the RPC configured for the payment’s chain, and returns what it answers', async () => {
      const { deps, decodePayment, upstreamFetch } = harness({ config: withRpc });
      upstreamFetch.mockImplementation(async (/** @type {URL|string} */ url) =>
        String(url) === 'https://base.example/rpc'
          ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: MAGIC_WORD }))
          : new Response(JSON.stringify({ accepts: CHALLENGE_ACCEPTS }), { status: 402 })
      );
      await paidCall(deps);

      const ethCall = /** @type {EthCall} */ (decodePayment.mock.lastCall?.[1]?.ethCall);
      expect(await ethCall({ chainId: 8453, to: '0xacc0', data: '0xdeadbeef' })).toBe(MAGIC_WORD);
      const rpcCall = upstreamFetch.mock.calls.find(([url]) => String(url) === 'https://base.example/rpc');
      expect(JSON.parse(String(rpcCall?.[1]?.body))).toMatchObject({
        method: 'eth_call',
        params: [{ to: '0xacc0', data: '0xdeadbeef' }, 'latest']
      });
    });

    // An RPC behind bot management answers a challenge page, not JSON. Live,
    // `mainnet.base.org` did exactly this to the deployed Worker: the parse
    // error became "the account did not validate", and the paid call failed
    // with a message blaming the payer's signature. The status and the body
    // have to reach the message, or the next one is just as invisible.
    it('names the status and the body when an RPC answers something that is not JSON', async () => {
      const { deps, decodePayment, upstreamFetch } = harness({ config: withRpc });
      upstreamFetch.mockImplementation(async (/** @type {URL|string} */ url) =>
        String(url) === 'https://base.example/rpc'
          ? new Response('<!DOCTYPE html><title>Just a moment...</title>', { status: 403 })
          : new Response(JSON.stringify({ accepts: CHALLENGE_ACCEPTS }), { status: 402 })
      );
      await paidCall(deps);
      const ethCall = /** @type {EthCall} */ (decodePayment.mock.lastCall?.[1]?.ethCall);
      await expect(ethCall({ chainId: 8453, to: '0xacc0', data: '0x' })).rejects.toThrow(
        /answered 403 with non-JSON: <!DOCTYPE html>/
      );
    });

    // Refusing beats guessing: an unconfigured chain means Verdikt cannot check
    // who authorized the payment, and `decodePayment` treats the throw as "did
    // not validate" rather than crediting an unverified payer.
    it('refuses a chain it has no RPC for, rather than reading some other chain', async () => {
      const { deps, decodePayment } = harness({ config: withRpc });
      await paidCall(deps);
      const ethCall = /** @type {EthCall} */ (decodePayment.mock.lastCall?.[1]?.ethCall);
      await expect(ethCall({ chainId: 137, to: '0xacc0', data: '0x' })).rejects.toThrow(/no RPC configured for chain 137/);
    });
  });

  it('reads the accepts probe’s challenge out of the v2 `payment-required` header when the body has none', async () => {
    const encoded = Buffer.from(JSON.stringify({ accepts: CHALLENGE_ACCEPTS })).toString('base64');
    const { deps, decodePayment } = harness({
      upstream: () => new Response('not json at all', { status: 402, headers: { 'payment-required': encoded } })
    });
    await paidCall(deps);
    expect(decodePayment).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accepts: CHALLENGE_ACCEPTS }));
  });

  // The enclave replays the payment to the provider itself (workflow.ts) and
  // must send it back under the same header name it arrived as — a v2
  // provider like Alchemy does not recognize `x-payment` at all. So the name,
  // not just the value, has to reach the workflow trigger.
  it('tells the workflow which header name the payment actually arrived as', async () => {
    const { deps, verify } = harness();
    await call(deps, {
      method: 'GET',
      url: '/weather/current?lat=52',
      headers: { host: 'proxy.local', 'payment-signature': 'v2-header' }
    });
    expect(verify.mock.lastCall?.[0]).toMatchObject({ paymentHeader: 'v2-header', paymentHeaderName: 'payment-signature' });
  });

  it('names `x-payment` when that is the header a v1 caller actually sent', async () => {
    const { deps, verify } = harness();
    await paidCall(deps);
    expect(verify.mock.lastCall?.[0]).toMatchObject({ paymentHeaderName: 'x-payment' });
  });
});

describe('the verified branch — outcomes that are not PASS', () => {
  it('relays a FAIL response with the verdict and the failing clause detail', async () => {
    const { deps } = harness({
      result: verdict({
        outcome: 'FAIL',
        status: 200,
        clauses: [{ id: 'speed', type: 'latency', pass: false, expected: '<= 5000ms', actual: '9000ms' }]
      })
    });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-verdikt-verdict']).toBe('FAIL');
    // The chain records only which clause broke. The agent that paid for this
    // response gets the comparison as well — it is the one party entitled to
    // it, which is why this is a header and not an event.
    expect(response.headers['x-verdikt-failed-clause']).toBe('speed');
    expect(response.headers['x-verdikt-failed-clause-type']).toBe('latency');
    expect(response.headers['x-verdikt-expected']).toBe('<= 5000ms');
    expect(response.headers['x-verdikt-actual']).toBe('9000ms');
  });

  // The same one the verdict records, so the header and the chain cannot
  // disagree about which promise was missed.
  it('names only the first failure, in the SLA declared order', async () => {
    const { deps } = harness({
      result: verdict({
        outcome: 'FAIL',
        clauses: [
          { id: 'shape', type: 'schema', pass: false, expected: 'a', actual: 'b' },
          { id: 'speed', type: 'latency', pass: false, expected: 'c', actual: 'd' }
        ]
      })
    });
    const response = await paidCall(deps);
    expect(response.headers['x-verdikt-failed-clause']).toBe('shape');
    expect(response.headers['x-verdikt-actual']).toBe('b');
  });

  it('says nothing about a clause when nothing broke', async () => {
    const { deps } = harness({
      result: verdict({ clauses: [{ id: 'speed', type: 'latency', pass: true, expected: 'x', actual: 'y' }] })
    });
    const response = await paidCall(deps);
    expect(response.headers['x-verdikt-failed-clause']).toBeUndefined();
    expect(response.headers['x-verdikt-expected']).toBeUndefined();
  });

  /**
   * These strings quote observed data, so they are treated as untrusted: a
   * newline in a header value splits it, and the next line would be read as a
   * header of the agent's own.
   */
  it('cannot be used to inject a header or blow the header block', async () => {
    const { deps } = harness({
      result: verdict({
        outcome: 'FAIL',
        clauses: [
          {
            id: 'shape',
            type: 'schema',
            pass: false,
            expected: 'present',
            actual: `absent\r\nx-verdikt-verdict: PASS ${'A'.repeat(400)}`
          }
        ]
      })
    });
    const response = await paidCall(deps);
    expect(response.headers['x-verdikt-verdict']).toBe('FAIL');
    const actual = String(response.headers['x-verdikt-actual']);
    expect(actual).not.toMatch(/[\r\n]/);
    expect(actual.length).toBeLessThanOrEqual(180);
  });

  it('relays a provider 5xx as a 5xx rather than dressing it up as a proxy error', async () => {
    // It is an SLA failure the engine has already judged; rewriting it would
    // hide from the agent what it actually bought.
    const { deps } = harness({ result: verdict({ outcome: 'FAIL', status: 503, body: 'upstream down' }) });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('upstream down');
    expect(response.headers['x-verdikt-verdict']).toBe('FAIL');
  });

  it('reports NONE when the fallback declined to write a verdict, and still delivers', async () => {
    // No verdict is not the same as no delivery: the agent paid for the 4xx.
    const { deps } = harness({
      result: verdict({ outcome: null, mode: 'status-only', reason: 'sla record unreadable', status: 404, tx: null })
    });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-verdikt-verdict']).toBe('NONE');
    expect(response.headers['x-verdikt-fallback-reason']).toBe('sla record unreadable');
  });

  it('flags a truncated payload rather than letting it look complete', async () => {
    const { deps } = harness({ result: verdict({ bodyTruncated: true }) });
    expect((await paidCall(deps)).headers['x-verdikt-body-truncated']).toBe('true');
  });
});

describe('the verified branch — failure modes (Tasks.md 4.4)', () => {
  it('still relays the payload when the Arc write missed, and flags it', async () => {
    // The agent paid for the response; the verdict can be rewritten, the
    // response cannot be refetched — an x402 payment settles once.
    const { deps } = harness({ result: verdict({ tx: null }) });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"current":{"temperature_2m":12.5}}');
    expect(response.headers['x-verdikt-verdict-unwritten']).toBe('true');
    expect(response.headers['x-verdikt-tx']).toBeUndefined();
  });

  it('surfaces a workflow timeout distinctly, never silently', async () => {
    const { deps } = harness({
      result: new VerificationError(VERIFICATION_FAILURE.TIMEOUT, 'no result within 45000ms')
    });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: 'workflow_timeout', paid: true, requestId: REQUEST_ID });
  });

  it('surfaces a rejected trigger as its own failure', async () => {
    const { deps } = harness({
      result: new VerificationError(VERIFICATION_FAILURE.TRIGGER_REJECTED, 'gateway returned 401')
    });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('trigger_rejected');
  });

  it('names the requestId on every failure, so a paying agent has something to quote', async () => {
    const { deps } = harness({ result: new Error('something unexpected') });
    const response = await paidCall(deps);
    expect(response.headers['x-verdikt-request-id']).toBe(REQUEST_ID);
    expect(response.json().requestId).toBe(REQUEST_ID);
  });

  it('refuses to verify at all when it cannot decode the payment', async () => {
    // Every refund targets the payer this returns, so guessing is not an option.
    const { deps, verify } = harness({ paymentError: new Error('NOT_IMPLEMENTED (Spike C)') });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe('payment_undecodable');
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses a paid call when no workflow is configured, rather than relaying it unverified', async () => {
    const { deps } = harness({ noWorkflow: true });
    const response = await paidCall(deps);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('verification_unavailable');
  });

  it('does not take the paid branch for an empty X-PAYMENT header', async () => {
    const { deps, verify } = harness();
    await call(deps, { method: 'GET', url: '/weather/current', headers: { host: 'proxy.local', 'x-payment': '' } });
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
