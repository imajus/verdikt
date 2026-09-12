// The Verdikt proxy (Specification.md §2, Tasks.md Phase 4), as a plain
// Request → Response function rather than a framework app. Cloudflare Workers
// have no long-lived process to host a Fastify server on, so `handleRequest`
// is what `worker.js` calls from its `fetch` handler, and what tests call
// directly with a constructed `Request` — the same seam `buildApp` used to be.
//
// Deliberately small: no wallet, no signing, no correlation store. The agent
// signs its own payment, and payer and amount ride in the payment payload, so
// there is no session state to keep between the challenge and the verdict.
//
// @verdikt/sla is NOT a dependency here. The proxy relays and never evaluates;
// if it ever needs the engine, something has moved to the wrong side of the
// enclave boundary.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRegistryReader, decodePayment, resolveServiceRecord } from '@verdikt/sdk';
import { checkOwnership, decodeChallenge } from './challenge.js';
import { discover, toListing } from './discovery.js';
import { assertRelayableUrl, bodyToHex, forwardRequestHeaders, forwardResponseHeaders, joinUpstream } from './http.js';
import { loadConfig } from './config.js';
import { VERIFICATION_FAILURE, VerificationError, parseWorkflowResult } from './verification.js';

/** Mirrors `VerdiktRegistry._assertValidSlug`. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * x402 v2 renamed `X-PAYMENT` to `PAYMENT-SIGNATURE`. A real v2 provider
 * (Alchemy) confirmed this live: a paid call carried `payment-signature` and
 * no `x-payment` at all, so a proxy that reads only the old name never
 * notices the call was paid for — it falls through to `passthrough()`, and
 * nothing is verified. `payment-signature` is checked first; `x-payment`
 * stays as a fallback for v1 callers.
 */
const PAYMENT_HEADER_NAMES = ['payment-signature', 'x-payment'];

/**
 * Returns both the value and which of `PAYMENT_HEADER_NAMES` matched — the
 * enclave replays the payment to the provider itself and must send it back
 * under the same name, so the name is as load-bearing downstream as the
 * value.
 *
 * @param {Headers} headers
 * @returns {{ name: string, value: string } | null}
 */
const paymentHeaderOf = (headers) => {
  for (const name of PAYMENT_HEADER_NAMES) {
    const value = headers.get(name);
    if (value) return { name, value };
  }
  return null;
};

/**
 * One `eth_call` against whichever chain a payment names, or `undefined` when
 * no RPC is configured for that chain.
 *
 * This exists only so `decodePayment` can ask a smart-contract account whether
 * it authorized a payment (ERC-1271) — a Circle agent wallet is one, and its
 * signature recovers to an owner key rather than to itself, so without this it
 * is refused. Built here rather than in the SDK because which chains Verdikt
 * is willing to read is deployment configuration, not a property of decoding.
 *
 * @param {ProxyConfig} config
 * @param {typeof fetch} doFetch
 * @returns {EthCall}
 */
const chainReader = (config, doFetch) => async ({ chainId, to, data }) => {
  const rpcUrl = config.paymentRpcUrls[chainId];
  if (!rpcUrl) throw new Error(`no RPC configured for chain ${chainId}`);
  try {
    const response = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs)
    });
    // Read as text first: an RPC that answers a bot-challenge page or an error
    // page fails `.json()` with a parse error naming neither the endpoint nor
    // the status, which is exactly the shape that is impossible to diagnose
    // from a log line.
    const text = await response.text();
    /** @type {{ result?: string, error?: { message?: string } }} */
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`answered ${response.status} with non-JSON: ${text.slice(0, 120)}`);
    }
    if (body.error) throw new Error(body.error.message ?? 'eth_call failed');
    return body.result ?? '0x';
  } catch (error) {
    // Deliberately loud. `decodePayment` treats a throw here as "the account
    // did not validate" so that an RPC hiccup cannot 500 a call the agent has
    // already paid for — which means the *reason* has no other way out. Left
    // silent, an unreachable RPC is indistinguishable from a forged signature,
    // and the paid call fails with a message blaming the payer.
    console.warn(`payment chain read failed (chain ${chainId}, ${rpcUrl}): ${/** @type {Error} */ (error).message}`);
    throw error;
  }
};

/** @param {unknown} body @param {number} [status] @param {Record<string,string>} [headers] */
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * Agents call `<slug>.verdikt.bond/<path>`; the path form exists so local
 * development and tests work without wildcard DNS. The hostname wins when it
 * is a subdomain of the public host, because that is the production route.
 *
 * Read off `request.url`'s own hostname rather than a `Host` header: a
 * Worker's `Request.url` already carries the hostname the request actually
 * arrived on, and reading it that way needs no header (some `fetch`
 * implementations refuse to let a constructed `Request` set `Host` at all).
 *
 * @param {Request} request
 * @param {ProxyConfig} config
 * @returns {{ slug: string, rest: string } | null}
 */
export function routeOf(request, config) {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const suffix = `.${config.publicHost.toLowerCase()}`;

  if (host.endsWith(suffix)) {
    const slug = host.slice(0, -suffix.length);
    if (!SLUG.test(slug)) return null;
    return { slug, rest: url.pathname.replace(/^\/+/, '') };
  }

  const [, slug, ...rest] = url.pathname.split('/');
  if (!slug || !SLUG.test(slug)) return null;
  return { slug, rest: rest.join('/') };
}

/**
 * @param {Request} request
 * @param {ProxyDeps} [deps]
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, deps = {}) {
  const config = deps.config ?? loadConfig();
  const resolve = deps.resolveServiceRecord ?? resolveServiceRecord;
  const registry = deps.registry ?? createRegistryReader(config.arc);
  const doFetch = deps.fetch ?? fetch;
  const decode = deps.decodePayment ?? decodePayment;
  const workflow = deps.workflow ?? null;
  const newRequestId = deps.newRequestId ?? (() => `0x${randomBytes(32).toString('hex')}`);
  // Injected rather than built here: the proxy relays, and a marketplace read is
  // a different job with a different failure mode. Absent means /services 503s
  // instead of the relay refusing to start.
  const marketplace = deps.marketplace ?? null;

  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return json({ ok: true });
  }

  // The machine-facing marketplace (Specification.md §5, stretch 2). Exact
  // routes, so they are matched ahead of the service catch-all below.
  if (request.method === 'GET' && url.pathname === '/services') {
    if (!marketplace) {
      return json({ error: 'discovery_unavailable', detail: 'no marketplace reader configured' }, 503);
    }
    try {
      const { services } = await marketplace();
      return json(discover(services, Object.fromEntries(url.searchParams), config.publicHost));
    } catch (error) {
      return json({ error: 'marketplace_unavailable', detail: /** @type {Error} */ (error).message }, 503);
    }
  }

  const servicesSlug = request.method === 'GET' ? url.pathname.match(/^\/services\/([^/]+)$/) : null;
  if (servicesSlug) {
    const slug = servicesSlug[1];
    if (!marketplace) {
      return json({ error: 'discovery_unavailable', detail: 'no marketplace reader configured' }, 503);
    }
    const { services } = await marketplace();
    const found = services.find((listing) => listing.slug === slug);
    if (!found) return json({ error: 'unknown_service', slug }, 404);
    return json(toListing(found, config.publicHost));
  }

  // Where the enclave pushes a finished verification (docs/spikes/cre.md,
  // CRE-9). An exact route, so it is matched ahead of the service catch-all
  // and can never be mistaken for a slug.
  if (request.method === 'POST' && url.pathname === '/internal/verification-callback') {
    return handleCallback(request, { config, workflow });
  }

  const route = routeOf(request, config);
  if (!route) {
    return json({ error: 'unknown_service', detail: 'no valid service slug in the host or path' }, 404);
  }
  const { slug, rest } = route;

  /** @type {ServiceRecord} */
  let record;
  try {
    record = await resolve(slug, { cacheTtlMs: config.ensCacheTtlMs });
  } catch (error) {
    // Distinct from "no records published": ENS being unreachable is our
    // outage, and the agent should retry rather than be told the service
    // does not exist.
    return json({ error: 'naming_layer_unavailable', detail: /** @type {Error} */ (error).message }, 503);
  }

  if (!record.url) {
    return json({ error: 'no_endpoint', detail: `${record.name} has published no url record` }, 502);
  }

  /** @type {ServiceState} */
  let state;
  try {
    state = await registry.getService(record.serviceId);
  } catch (error) {
    return json({ error: 'registry_unavailable', detail: /** @type {Error} */ (error).message }, 503);
  }

  const ownership = checkOwnership(record.owner, state.provider);
  if (!ownership.ok) {
    return json(
      { error: 'owner_mismatch', reason: ownership.reason, detail: ownership.detail, service: record.name },
      409,
      { 'x-verdikt-block': ownership.reason }
    );
  }

  // Checked on the unpaid leg too, not just before a payment: an agent that
  // never receives a challenge for a suspended service cannot pay one.
  if (state.status !== 'ACTIVE') {
    return json(
      {
        error: 'service_not_active',
        status: state.status,
        detail:
          state.status === 'SUSPENDED'
            ? 'refunds drained this service’s bond; it is not routing until topped up'
            : `service is ${state.status}`
      },
      503
    );
  }

  let upstream;
  try {
    upstream = joinUpstream(assertRelayableUrl(record.url, config.allowPrivateUpstream), rest, url.search);
  } catch (error) {
    return json({ error: 'bad_upstream', detail: /** @type {Error} */ (error).message }, 502);
  }

  // Bodies are relayed byte-for-byte, buffered once here rather than streamed:
  // re-serialising them would change what the provider — and therefore the
  // SLA's schema clause — actually sees, and there is no method here that
  // needs the original body streamed rather than replayed whole.
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();

  const paymentHeader = paymentHeaderOf(request.headers);
  if (paymentHeader) {
    return verified({ request, record, upstream, paymentHeader, decode, workflow, newRequestId, doFetch, config, body });
  }

  return passthrough({ request, upstream, body, doFetch, config });
}

/**
 * The unpaid leg: relay unchanged, 402 challenge included. The proxy's trust
 * anchor is the service's registered `url` (bound to the slug's bond via
 * `checkOwnership`) — whatever `payTo` that URL's own 402 challenge names is
 * exactly as legitimate as the URL itself, so there is nothing here for the
 * proxy to verify before the agent sees it (issue #37).
 *
 * @param {{
 *   request: Request,
 *   upstream: URL,
 *   body: ArrayBuffer|undefined,
 *   doFetch: typeof fetch,
 *   config: ProxyConfig
 * }} args
 */
async function passthrough({ request, upstream, body, doFetch, config }) {
  let response;
  try {
    response = await doFetch(upstream, {
      method: request.method,
      headers: forwardRequestHeaders(Object.fromEntries(request.headers)),
      body,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      redirect: 'manual'
    });
  } catch (error) {
    return json({ error: 'upstream_unreachable', detail: /** @type {Error} */ (error).message }, 502);
  }

  const headers = forwardResponseHeaders(response.headers);
  return new Response(await response.arrayBuffer(), { status: response.status, headers });
}

/**
 * Header-safe rendering of one field of a clause result.
 *
 * A newline in a header value splits it, and whatever follows is read as a
 * header of the agent's own — so this flattens and bounds the value. These
 * strings come from `@verdikt/sla` rather than from the provider, but they
 * quote observed data (a JSON pointer into the response body), so they are
 * treated as untrusted text.
 *
 * @param {string} value
 */
const headerSafe = (value) => {
  const flat = value.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?');
  return flat.length > 180 ? `${flat.slice(0, 177)}...` : flat;
};

/**
 * Tell the agent *which* promise was missed, and by how much.
 *
 * The chain records only the clause id, and deliberately: the observed value is
 * a slice of a response someone paid for, and a public chain would publish it
 * to everyone. Here it goes to exactly one party — the agent that paid for that
 * response and is still holding the connection. It already has the body; what
 * it does not have is the provider's own declared bound and the comparison
 * Verdikt made against it.
 *
 * The first failing clause only, in the SLA's declared order — the same one the
 * verdict records, so the header and the chain cannot disagree.
 *
 * @param {SlaClauseResult[]} clauses
 * @returns {Record<string, string>}
 */
function failureDetailHeaders(clauses) {
  const broke = clauses.find((clause) => !clause.pass);
  if (!broke) return {};
  return {
    'x-verdikt-failed-clause': headerSafe(broke.id),
    'x-verdikt-failed-clause-type': headerSafe(broke.type),
    'x-verdikt-expected': headerSafe(broke.expected),
    'x-verdikt-actual': headerSafe(broke.actual)
  };
}

/**
 * The paid leg (Specification.md §2, Tasks.md 4.3).
 *
 * The proxy relays and never evaluates. It hands the enclave everything the
 * judgement needs — including the raw `sla` record, because
 * `packages/sdk/ens.js` is the only file that knows ENS exists and the enclave
 * is not an exception — and waits for the result.
 *
 * Every failure path here is shaped by one fact: **the agent has already paid.**
 * Nothing may silently swallow what they bought.
 *
 * @param {{
 *   request: Request,
 *   record: ServiceRecord,
 *   upstream: URL,
 *   paymentHeader: { name: string, value: string },
 *   decode: (header: string, options: { accepts: unknown[], ethCall?: EthCall }) => Promise<DecodedPayment>,
 *   workflow: WorkflowClient|null,
 *   newRequestId: () => string,
 *   doFetch: typeof fetch,
 *   config: ProxyConfig,
 *   body: ArrayBuffer|undefined
 * }} args
 */
async function verified({ request, record, upstream, paymentHeader, decode, workflow, newRequestId, doFetch, config, body }) {
  if (!workflow) {
    return json({
      error: 'verification_unavailable',
      detail: 'the proxy is not configured with a workflow endpoint, so no paid call can be verified'
    }, 503);
  }

  // decodePayment needs the challenge's own `accepts` to know the asset, name
  // and version behind the EIP-712 domain — the payment header itself names
  // only scheme and network (packages/sdk/payment.js). So it is fetched fresh
  // here, the same request the unpaid leg would have made, with every payment
  // header name stripped so this probe cannot itself settle the payment.
  const challengeHeaders = forwardRequestHeaders(Object.fromEntries(request.headers));
  for (const name of PAYMENT_HEADER_NAMES) delete challengeHeaders[name];
  /** @type {unknown[]} */
  let accepts;
  try {
    const challengeResponse = await doFetch(upstream, {
      method: request.method,
      headers: challengeHeaders,
      body,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs)
    });
    const challengeJson =
      decodeChallenge(challengeResponse.headers.get('payment-required'), await challengeResponse.text().catch(() => '')) ??
      {};
    accepts = Array.isArray(challengeJson?.accepts) ? challengeJson.accepts : [];
  } catch (error) {
    return json(
      {
        error: 'challenge_unavailable',
        detail: `could not fetch the provider's payment challenge to verify against: ${/** @type {Error} */ (error).message}`
      },
      502
    );
  }

  /** @type {DecodedPayment} */
  let payment;
  try {
    payment = await decode(paymentHeader.value, { accepts, ethCall: chainReader(config, doFetch) });
  } catch (error) {
    // Refused before the workflow is triggered: every refund targets the payer
    // this returns, so a proxy that cannot decode a payment must not verify one.
    return json({ error: 'payment_undecodable', detail: /** @type {Error} */ (error).message }, 500);
  }

  const requestId = newRequestId();
  /** @type {VerificationResult} */
  let result;
  try {
    result = await workflow.verify({
      serviceId: record.serviceId,
      requestId,
      providerUrl: upstream.toString(),
      method: request.method,
      paymentHeader: paymentHeader.value,
      paymentHeaderName: paymentHeader.name,
      bodyHex: bodyToHex(body),
      contentType: request.headers.get('content-type'),
      payer: payment.payer,
      paidAmountMinorUnits: payment.amount.toString(),
      sla: record.sla
    });
  } catch (error) {
    const failure = error instanceof VerificationError ? error.failure : VERIFICATION_FAILURE.RUN_FAILED;
    // Deliberately visible, and deliberately not a 502-that-looks-like-the-
    // provider's-fault. The agent has paid; a swallowed error here is
    // indistinguishable from a service that took the money and returned nothing.
    return json(
      {
        error: failure,
        detail: /** @type {Error} */ (error).message,
        requestId,
        paid: true,
        advice: 'the payment settled; the response could not be delivered. Keep this requestId.'
      },
      failure === VERIFICATION_FAILURE.TIMEOUT ? 504 : 502,
      { 'x-verdikt-request-id': requestId }
    );
  }

  const headers = {
    'x-verdikt-verdict': result.outcome ?? 'NONE',
    'x-verdikt-mode': result.mode,
    'x-verdikt-request-id': requestId,
    ...failureDetailHeaders(result.clauses),
    ...(result.tx ? { 'x-verdikt-tx': result.tx } : {}),
    // The Arc write missed but the enclave still has the response. Relaying it
    // and flagging the miss beats destroying a paid-for payload over
    // bookkeeping (Tasks.md 4.4).
    ...(result.outcome && !result.tx ? { 'x-verdikt-verdict-unwritten': 'true' } : {}),
    ...(result.reason ? { 'x-verdikt-fallback-reason': result.reason } : {}),
    ...(result.bodyTruncated ? { 'x-verdikt-body-truncated': 'true' } : {})
  };

  // The provider's own status is relayed, not rewritten. A provider 5xx is an
  // SLA failure that `evaluate` has already judged — turning it into a proxy
  // error would hide from the agent what it actually bought.
  return new Response(result.body, { status: result.status ?? 502, headers: { ...result.headers, ...headers } });
}

/**
 * Two things authenticate a callback, and both matter. The bearer is a shared
 * secret the workflow holds; `requestId` is 32 random bytes this process
 * issued and has not yet answered. Forging a callback would put
 * attacker-chosen bytes in front of a paying agent — it could not fake the
 * on-chain verdict, which the DON signs, but the agent would still be handed
 * the wrong response.
 *
 * @param {Request} request
 * @param {{ config: ProxyConfig, workflow: WorkflowClient|null }} deps
 */
async function handleCallback(request, { config, workflow }) {
  if (!config.callbackToken || !bearerMatches(request.headers.get('authorization'), config.callbackToken)) {
    return json({ error: 'unauthorized' }, 401);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'malformed_callback' }, 400);
  }
  const requestId = /** @type {{ requestId?: unknown }} */ (payload)?.requestId;
  if (typeof requestId !== 'string') return json({ error: 'missing_request_id' }, 400);

  // Unknown means already answered, timed out, or never issued here. Accepting
  // it would be accepting a result nobody asked for.
  const delivered = await workflow?.pending?.settle(requestId, parseWorkflowResult(payload));
  if (!delivered) return json({ error: 'no_such_pending_request', requestId }, 409);
  return json({ ok: true });
}

/**
 * Constant-time bearer comparison. A plain `===` leaks the shared secret one
 * character at a time to anyone who can time the endpoint.
 *
 * @param {string|null} header
 * @param {string} expected
 */
function bearerMatches(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}
