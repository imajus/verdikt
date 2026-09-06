import { describe, expect, it, vi } from 'vitest';
import { SERVICE_RECORD } from '@verdikt/fixtures';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const SPOOFED = '0x9999999999999999999999999999999999999999';

const config = loadConfig({ PROXY_PUBLIC_HOST: 'verdikt.bond', VERDIKT_REGISTRY_ADDRESS: '0x01' });

/** @param {Partial<ServiceRecord>} [overrides] */
const record = (overrides = {}) => ({
  ...SERVICE_RECORD,
  address: PAY_TO,
  url: 'https://provider.example/weather',
  ...overrides
});

/** @param {{ accepts?: unknown[] }} [overrides] */
const challenge = (overrides = {}) =>
  JSON.stringify({
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [
      {
        scheme: 'GatewayWalletBatched',
        network: 'arc-testnet',
        maxAmountRequired: '2500',
        resource: 'https://provider.example/weather',
        payTo: PAY_TO,
        asset: 'USDC'
      }
    ],
    ...overrides
  });

/**
 * @param {object} [options]
 * @param {Partial<ServiceRecord>} [options.serviceRecord]
 * @param {ServiceStatus} [options.status]
 * @param {Response|(() => Response|Promise<Response>)} [options.upstream]
 * @param {Error} [options.ensError]
 */
function harness({ serviceRecord = {}, status = 'ACTIVE', upstream, ensError } = {}) {
  const upstreamFetch = vi.fn(async (/** @type {URL|string} */ _url, /** @type {RequestInit} */ _init) =>
    typeof upstream === 'function' ? upstream() : (upstream ?? new Response('ok', { status: 200 }))
  );
  const app = buildApp({
    config,
    resolveServiceRecord: vi.fn(async () => {
      if (ensError) throw ensError;
      return record(serviceRecord);
    }),
    registry: {
      getService: vi.fn(async () => ({ provider: '0x03', status, deposit: 10n ** 19n }))
    },
    fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (upstreamFetch))
  });
  return { app, upstreamFetch };
}

/** @param {import('fastify').FastifyInstance} app */
const call = (app, options = {}) =>
  app.inject({ method: 'GET', url: '/weather/current?lat=52', headers: { host: 'proxy.local' }, ...options });

describe('routing', () => {
  it('takes the slug from the host subdomain, which is how agents actually call', async () => {
    const { app, upstreamFetch } = harness();
    await app.inject({ method: 'GET', url: '/current', headers: { host: 'weather.verdikt.bond' } });
    expect(String(upstreamFetch.mock.lastCall?.[0])).toBe('https://provider.example/weather/current');
  });

  it('also accepts the path form, so local development needs no wildcard DNS', async () => {
    const { app, upstreamFetch } = harness();
    await call(app);
    expect(String(upstreamFetch.mock.lastCall?.[0])).toBe('https://provider.example/weather/current?lat=52');
  });

  it('404s a slug that could never be a service', async () => {
    const { app } = harness();
    const response = await app.inject({ method: 'GET', url: '/Weather/x', headers: { host: 'proxy.local' } });
    expect(response.statusCode).toBe(404);
  });

  it('answers a health check without touching either chain', async () => {
    const { app } = harness();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('passthrough — non-challenge responses', () => {
  it('relays a 200 unchanged', async () => {
    const { app } = harness({
      upstream: new Response('{"temp":12}', { status: 200, headers: { 'content-type': 'application/json' } })
    });
    const response = await call(app);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"temp":12}');
    expect(response.headers['content-type']).toBe('application/json');
  });

  it('relays a provider 5xx rather than turning it into a proxy error', async () => {
    // It is an SLA failure, not ours, and on the paid leg it must reach evaluate().
    const { app } = harness({ upstream: new Response('boom', { status: 503 }) });
    expect((await call(app)).statusCode).toBe(503);
  });

  it('reports an unreachable provider as a gateway error', async () => {
    const { app } = harness({
      upstream: () => {
        throw new Error('ECONNREFUSED');
      }
    });
    const response = await call(app);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('upstream_unreachable');
  });
});

describe('passthrough — the payTo check', () => {
  it('relays a challenge whose payTo matches the published address', async () => {
    const body = challenge();
    const { app } = harness({ upstream: new Response(body, { status: 402 }) });
    const response = await call(app);

    expect(response.statusCode).toBe(402);
    expect(response.body).toBe(body);
    expect(response.headers['x-verdikt-pay-to-verified']).toBe('true');
  });

  it('blocks and does not relay a spoofed payTo', async () => {
    const spoofed = challenge({ accepts: [{ scheme: 'x', payTo: SPOOFED }] });
    const { app } = harness({ upstream: new Response(spoofed, { status: 402 }) });
    const response = await call(app);

    expect(response.statusCode).toBe(502);
    expect(response.headers['x-verdikt-block']).toBe('pay_to_mismatch');
    // What must not reach the agent is the signable challenge — a payment sent
    // to a spoofed payTo leaves no bond to reclaim from, unlike every other
    // check in the system. The block names the wrong address in prose because
    // an operator needs to see what the provider actually returned; that is not
    // something an x402 client can sign against.
    expect(response.statusCode).not.toBe(402);
    expect(response.json().accepts).toBeUndefined();
    expect(response.json().expectedPayTo).toBe(PAY_TO);
  });

  it('blocks when any one option among honest ones is spoofed', async () => {
    // The agent may pick any entry, so a single bad option is a bad challenge.
    const mixed = challenge({ accepts: [{ payTo: PAY_TO }, { payTo: SPOOFED }] });
    const { app } = harness({ upstream: new Response(mixed, { status: 402 }) });
    expect((await call(app)).headers['x-verdikt-block']).toBe('pay_to_mismatch');
  });

  it('compares addresses without regard to checksum case', async () => {
    const upper = challenge({ accepts: [{ payTo: PAY_TO.toUpperCase().replace('0X', '0x') }] });
    const { app } = harness({ upstream: new Response(upper, { status: 402 }) });
    expect((await call(app)).statusCode).toBe(402);
  });

  it('blocks a challenge it cannot read rather than passing it through', async () => {
    const { app } = harness({ upstream: new Response('<html>402</html>', { status: 402 }) });
    expect((await call(app)).headers['x-verdikt-block']).toBe('unparseable_challenge');
  });

  it('blocks a challenge that offers no payTo at all', async () => {
    const { app } = harness({ upstream: new Response(JSON.stringify({ accepts: [] }), { status: 402 }) });
    expect((await call(app)).headers['x-verdikt-block']).toBe('challenge_has_no_pay_to');
  });

  it('blocks when the service has published no address to compare against', async () => {
    const { app } = harness({
      serviceRecord: { address: null },
      upstream: new Response(challenge(), { status: 402 })
    });
    expect((await call(app)).headers['x-verdikt-block']).toBe('no_address_record');
  });
});

describe('refusals before any upstream call', () => {
  it('refuses to route to a suspended service', async () => {
    const { app, upstreamFetch } = harness({ status: 'SUSPENDED' });
    const response = await call(app);
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe('SUSPENDED');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('refuses a service that was never registered', async () => {
    const { app } = harness({ status: 'NONE' });
    expect((await call(app)).statusCode).toBe(503);
  });

  it('reports an unreachable naming layer as our outage, not a missing service', async () => {
    const { app } = harness({ ensError: new Error('sepolia down') });
    const response = await call(app);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('naming_layer_unavailable');
  });

  it('refuses a service that has published no endpoint', async () => {
    const { app, upstreamFetch } = harness({ serviceRecord: { url: null } });
    expect((await call(app)).json().error).toBe('no_endpoint');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('refuses a provider url pointed at a private host', async () => {
    // Otherwise the `url` record is a server-side-request-forgery primitive
    // aimed at whatever Verdikt's network can reach.
    const { app, upstreamFetch } = harness({ serviceRecord: { url: 'http://169.254.169.254/latest/meta-data' } });
    const response = await call(app);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('bad_upstream');
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  // Path escape is covered in http.test.js, at `joinUpstream`'s own level:
  // fastify's `inject` normalises dot-segments before a handler ever sees them,
  // while a real Node server hands the raw path straight through, so an
  // app-level test here would assert the injector's behaviour, not the proxy's.
});

describe('the paid leg', () => {
  it('is a distinct answer from "no such service" — the agent may already have paid', async () => {
    const { app } = harness();
    const response = await call(app, { headers: { host: 'proxy.local', 'x-payment': 'abc' } });
    expect(response.statusCode).toBe(501);
    expect(response.json().error).toBe('verified_branch_not_implemented');
  });
});
