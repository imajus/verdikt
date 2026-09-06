// The Verdikt proxy (Specification.md §2, Tasks.md Phase 4).
//
// Deliberately small: no wallet, no signing, no correlation store. The agent
// signs its own payment, and payer and amount ride in the payment payload, so
// there is no session state to keep between the challenge and the verdict.
//
// @verdikt/sla is NOT a dependency here. The proxy relays and never evaluates;
// if it ever needs the engine, something has moved to the wrong side of the
// enclave boundary.

import Fastify from 'fastify';
import { createRegistryReader, resolveServiceRecord } from '@verdikt/sdk';
import { checkChallenge } from './challenge.js';
import { assertRelayableUrl, forwardRequestHeaders, forwardResponseHeaders, joinUpstream } from './http.js';
import { loadConfig } from './config.js';

/** Mirrors `VerdiktRegistry._assertValidSlug`. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Agents call `<slug>.verdikt.bond/<path>`; the path form exists so local
 * development and tests work without wildcard DNS. The Host header wins when it
 * is a subdomain of the public host, because that is the production route.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {ProxyConfig} config
 * @returns {{ slug: string, rest: string } | null}
 */
export function routeOf(request, config) {
  const host = String(request.headers.host ?? '').split(':')[0].toLowerCase();
  const suffix = `.${config.publicHost.toLowerCase()}`;
  const path = request.url.split('?')[0];

  if (host.endsWith(suffix)) {
    const slug = host.slice(0, -suffix.length);
    if (!SLUG.test(slug)) return null;
    return { slug, rest: path.replace(/^\/+/, '') };
  }

  const [, slug, ...rest] = path.split('/');
  if (!slug || !SLUG.test(slug)) return null;
  return { slug, rest: rest.join('/') };
}

/**
 * @param {ProxyDeps} [deps]
 * @returns {import('fastify').FastifyInstance}
 */
export function buildApp(deps = {}) {
  const config = deps.config ?? loadConfig();
  const resolve = deps.resolveServiceRecord ?? resolveServiceRecord;
  const registry = deps.registry ?? createRegistryReader(config.arc);
  const doFetch = deps.fetch ?? fetch;

  const app = Fastify({ logger: deps.logger ?? false });

  // Bodies are relayed byte-for-byte. Fastify's JSON parser would re-serialise
  // them, which changes what the provider — and therefore the SLA's schema
  // clause — actually sees.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body.length > 0 ? body : undefined)
  );

  app.get('/healthz', async () => ({ ok: true }));

  app.all('/*', async (request, reply) => {
    const route = routeOf(request, config);
    if (!route) {
      return reply.code(404).send({ error: 'unknown_service', detail: 'no valid service slug in the host or path' });
    }
    const { slug, rest } = route;

    /** @type {ServiceRecord} */
    let record;
    try {
      record = await resolve(slug, { cacheTtlMs: config.ensCacheTtlMs, parentName: config.parentName });
    } catch (error) {
      // Distinct from "no records published": ENS being unreachable is our
      // outage, and the agent should retry rather than be told the service
      // does not exist.
      return reply
        .code(503)
        .send({ error: 'naming_layer_unavailable', detail: /** @type {Error} */ (error).message });
    }

    if (!record.url) {
      return reply
        .code(502)
        .send({ error: 'no_endpoint', detail: `${record.name} has published no url record` });
    }

    /** @type {ServiceState} */
    let state;
    try {
      state = await registry.getService(record.serviceId);
    } catch (error) {
      return reply.code(503).send({ error: 'registry_unavailable', detail: /** @type {Error} */ (error).message });
    }

    // Checked on the unpaid leg too, not just before a payment: an agent that
    // never receives a challenge for a suspended service cannot pay one.
    if (state.status !== 'ACTIVE') {
      return reply.code(503).send({
        error: 'service_not_active',
        status: state.status,
        detail:
          state.status === 'SUSPENDED'
            ? 'refunds drained this service’s bond; it is not routing until topped up'
            : `service is ${state.status}`
      });
    }

    let upstream;
    try {
      upstream = joinUpstream(assertRelayableUrl(record.url, config.allowPrivateUpstream), rest, request.url.includes('?') ? `?${request.url.split('?').slice(1).join('?')}` : '');
    } catch (error) {
      return reply.code(502).send({ error: 'bad_upstream', detail: /** @type {Error} */ (error).message });
    }

    if (request.headers['x-payment']) {
      // Tasks.md 4.3 / issue #11. Distinct from a 404 so an agent that has
      // already paid is never told its service does not exist.
      return reply.code(501).send({
        error: 'verified_branch_not_implemented',
        detail: 'the paid leg lands with the confidential workflow'
      });
    }

    return passthrough({ request, reply, record, upstream, doFetch, config });
  });

  return app;
}

/**
 * The unpaid leg: relay, then check the challenge before the agent ever sees a
 * `payTo` to sign against.
 *
 * @param {{
 *   request: import('fastify').FastifyRequest,
 *   reply: import('fastify').FastifyReply,
 *   record: ServiceRecord,
 *   upstream: URL,
 *   doFetch: typeof fetch,
 *   config: ProxyConfig
 * }} args
 */
async function passthrough({ request, reply, record, upstream, doFetch, config }) {
  let response;
  try {
    response = await doFetch(upstream, {
      method: request.method,
      headers: forwardRequestHeaders(request.headers),
      body: /** @type {BodyInit|undefined} */ (request.body ?? undefined),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      redirect: 'manual'
    });
  } catch (error) {
    return reply.code(502).send({ error: 'upstream_unreachable', detail: /** @type {Error} */ (error).message });
  }

  const headers = forwardResponseHeaders(response.headers);

  if (response.status !== 402) {
    // Nothing to verify on a non-challenge response: no payment is being
    // proposed, so there is no payTo to spoof.
    const body = Buffer.from(await response.arrayBuffer());
    return reply.code(response.status).headers(headers).send(body);
  }

  const body = await response.text();
  const verdict = checkChallenge(body, record.address);
  if (!verdict.ok) {
    // The challenge is deliberately NOT relayed. Passing it on with a warning
    // would still put a spoofed payTo in front of an agent that might sign it,
    // and a payment to a spoofed address leaves no bond to reclaim from.
    return reply.code(502).headers({ 'x-verdikt-block': verdict.reason }).send({
      error: 'pay_to_mismatch',
      reason: verdict.reason,
      detail: verdict.detail,
      service: record.name,
      expectedPayTo: record.address
    });
  }

  return reply
    .code(402)
    .headers({ ...headers, 'x-verdikt-pay-to-verified': 'true' })
    .send(body);
}
