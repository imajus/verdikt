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
import { EVIDENCE_AUTH_HEADER, authorizeDisclosure, buildEnvelope } from './evidence.js';
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
  // A request that arrived on the service wildcard is resolved by its host and
  // by nothing else. Falling through to the path form when the host label is
  // not a slug would let `a.b.verdikt.bond/weather/...` be served as `weather`.
  if (onServiceHost(url, config)) {
    const fromHost = hostSlug(url, config);
    return fromHost === null ? null : { slug: fromHost, rest: url.pathname.replace(/^\/+/, '') };
  }
  const [, slug, ...rest] = url.pathname.split('/');
  if (!slug || !SLUG.test(slug)) return null;
  return { slug, rest: rest.join('/') };
}

/**
 * Whether the request arrived on the `<slug>.verdikt.bond` wildcard at all —
 * separate from whether the label is a usable slug, because the two answers
 * are needed in different places.
 *
 * @param {URL} url
 * @param {ProxyConfig} config
 * @returns {boolean}
 */
function onServiceHost(url, config) {
  return url.hostname.toLowerCase().endsWith(`.${config.publicHost.toLowerCase()}`);
}

/**
 * The slug when the request arrived on `<slug>.verdikt.bond`, else null.
 *
 * @param {URL} url
 * @param {ProxyConfig} config
 * @returns {string | null}
 */
function hostSlug(url, config) {
  if (!onServiceHost(url, config)) return null;
  const host = url.hostname.toLowerCase();
  const slug = host.slice(0, -(config.publicHost.length + 1));
  return SLUG.test(slug) ? slug : null;
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
  // Absent means a paid call caches nothing and the evidence endpoint says so.
  // Not fatal — the deterministic leg is unaffected — but no semantic claim
  // over a call made while it was absent can ever be judged.
  const evidence = deps.evidence ?? null;

  const url = new URL(request.url);

  // The proxy's own routes answer on the apex and in the path form only. On
  // `<slug>.verdikt.bond` every path belongs to the service, so a path
  // reserved here is a provider path made unreachable: an agent calling
  // `weather.verdikt.bond/internal/status` would get a proxy 404 rather than
  // the provider's answer. Only the path form has a slug to disambiguate.
  if (!onServiceHost(url, config)) {
    const own = await proxyRoute(request, url, { config, marketplace, workflow, resolve, registry, evidence });
    if (own) return own;
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

  // Read Arc before judging the ENS records, not after. The registry is the
  // only authority on whether a slug is a service at all, and `Status.NONE`
  // is how it says no. Checking `url` first meant an unregistered slug was
  // reported as a broken gateway — `www.verdikt.bond` answered 502, and so
  // did every typo — when the honest answer is that there is no such service.
  // A registered service still resolves both records, so this costs the
  // normal path nothing; only a slug that is not a service pays for the extra
  // read, and that is the one we were answering wrongly.
  /** @type {ServiceState} */
  let state;
  try {
    state = await registry.getService(record.serviceId);
  } catch (error) {
    return json({ error: 'registry_unavailable', detail: /** @type {Error} */ (error).message }, 503);
  }

  if (state.status === 'NONE') {
    return json({ error: 'unknown_service', slug, detail: `${slug} is not a registered service` }, 404);
  }

  // Reached only for a slug Arc does know, so this now means what it says: a
  // real service whose provider has published no endpoint to relay to.
  if (!record.url) {
    return json({ error: 'no_endpoint', detail: `${record.name} has published no url record` }, 502);
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
    return verified({ request, record, upstream, paymentHeader, decode, workflow, newRequestId, doFetch, config, body, evidence });
  }

  return passthrough({ request, upstream, body, doFetch, config });
}

/**
 * Verdikt's own surface: health, the machine-facing marketplace
 * (Specification.md §5, stretch 2), and the `/internal/` namespace. Returns
 * null when the path is none of them, which is the signal to relay it.
 *
 * Reached only off a service host, so a slug can never be shadowed by one of
 * these, and — in the path form — `internal` can never be read as a slug.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {{
 *   config: ProxyConfig,
 *   marketplace: (() => Promise<Marketplace>)|null,
 *   workflow: WorkflowClient|null,
 *   resolve: typeof resolveServiceRecord,
 *   registry: Pick<RegistryReader, 'getVerdict'>,
 *   evidence: EvidenceStore|null
 * }} deps
 * @returns {Promise<Response|null>}
 */
async function proxyRoute(request, url, { config, marketplace, workflow, resolve, registry, evidence }) {
  if (request.method === 'GET' && url.pathname === '/healthz') {
    return json({ ok: true });
  }

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

  if (url.pathname !== '/internal' && !url.pathname.startsWith('/internal/')) return null;

  // Where the enclave pushes a finished verification (docs/spikes/cre.md,
  // CRE-9).
  if (request.method === 'POST' && url.pathname === '/internal/verification-callback') {
    return handleCallback(request, { config, workflow });
  }

  const slaSlug = request.method === 'GET' ? url.pathname.match(/^\/internal\/sla\/([^/]+)$/) : null;
  if (slaSlug) {
    return handleSlaRead(slaSlug[1], { config, resolve });
  }

  const evidenceId = request.method === 'GET' ? url.pathname.match(/^\/internal\/evidence\/([^/]+)$/) : null;
  if (evidenceId) {
    return handleEvidenceRead(evidenceId[1], request, { config, registry, evidence });
  }

  // `/internal/` is reserved as a whole, not route by route: without it the
  // path form's catch-all reads `internal` as a slug and relays to whatever
  // service is registered under that name — so a POST to a GET-only internal
  // route, or a typo in one, became a proxied call.
  return json({ error: 'unknown_internal_route', detail: `${request.method} ${url.pathname}` }, 404);
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
 *   body: ArrayBuffer|undefined,
 *   evidence: EvidenceStore|null
 * }} args
 */
async function verified({ request, record, upstream, paymentHeader, decode, workflow, newRequestId, doFetch, config, body, evidence }) {
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

  // Cached before the response is built, and never allowed to break it: the
  // agent has paid, and a storage hiccup must not cost it the payload it bought.
  // A call with no verdict (the 402 replay and 4xx carve-outs) is skipped —
  // there is no verdict for a claim to be bound to, so evidence for it could
  // never be disclosed anyway.
  if (evidence && result.outcome) {
    try {
      await evidence.store(
        requestId,
        buildEnvelope({
          requestId,
          slug: record.slug,
          method: request.method,
          url: upstream.toString(),
          requestBody: body,
          result
        }),
        config.evidenceFilingWindowMs
      );
    } catch (error) {
      console.warn(`[verdikt] evidence not cached for ${requestId}: ${/** @type {Error} */ (error).message}`);
    }
  }

  const headers = {
    'x-verdikt-verdict': result.outcome ?? 'NONE',
    'x-verdikt-mode': result.mode,
    'x-verdikt-request-id': requestId,
    // Where to dispute this call (issue #114): the GenLayer claim judge's
    // address and chain id, so an agent that holds this response, its
    // requestId and the SLA it read never needs to read this repo to find the
    // contract. `getContractSchema`/`get_config()` on the judge itself answer
    // everything else. Omitted when `config.genlayer` is unset rather than
    // sent stale or empty — and omitted on a call with no verdict for exactly
    // the reason the evidence cache above skips one: there is nothing for a
    // claim to be bound to, and no envelope was kept, so naming a judge would
    // point the agent at a claim it can never open.
    ...(config.genlayer && result.outcome
      ? {
          'x-verdikt-judge-chain-id': String(config.genlayer.chainId),
          'x-verdikt-judge-address': config.genlayer.judgeAddress
        }
      : {}),
    ...failureDetailHeaders(result.clauses),
    ...(result.tx ? { 'x-verdikt-tx': result.tx } : {}),
    // The Arc write missed but the enclave still has the response. Relaying it
    // and flagging the miss beats destroying a paid-for payload over
    // bookkeeping (Tasks.md 4.4).
    ...(result.outcome && !result.tx ? { 'x-verdikt-verdict-unwritten': 'true' } : {}),
    // headerSafe: the reason quotes the provider-authored SLA, and a live one
    // carried an em dash that made undici throw while building this response.
    ...(result.reason ? { 'x-verdikt-fallback-reason': headerSafe(result.reason) } : {}),
    ...(result.bodyTruncated ? { 'x-verdikt-body-truncated': 'true' } : {})
  };

  // The provider's own status is relayed, not rewritten. A provider 5xx is an
  // SLA failure that `evaluate` has already judged — turning it into a proxy
  // error would hide from the agent what it actually bought.
  return new Response(result.body, { status: result.status ?? 502, headers: { ...result.headers, ...headers } });
}

/**
 * The service's SLA, over HTTP, for a caller that cannot import the SDK.
 *
 * `SlaClaimJudge` runs inside GenVM and has no way to reach `packages/sdk` or
 * an ENS library, so this exposes the one `resolveServiceRecord` call it needs
 * to freeze the disputed clause's `criteria` at claim-open time
 * (docs/GenLayer.md).
 *
 * Deliberately unauthenticated. The `sla` and `url` text records are public on
 * Sepolia and readable by anyone with an RPC endpoint; a token here would
 * protect nothing and would have to be shared with every GenLayer validator,
 * which is the opposite of a secret. `/internal/` is the namespace for
 * machine-facing routes, not a claim that they are private — the evidence
 * endpoint next door is gated because what it serves is genuinely not public.
 *
 * It adds no ENS logic of its own: `packages/sdk/ens.js` stays the only file
 * that knows ENS exists.
 *
 * @param {string} slug
 * @param {{ config: ProxyConfig, resolve: typeof resolveServiceRecord }} deps
 */
async function handleSlaRead(slug, { config, resolve }) {
  if (!SLUG.test(slug)) {
    return json({ error: 'unknown_service', slug, detail: 'not a valid service slug' }, 404);
  }

  /** @type {ServiceRecord} */
  let record;
  try {
    record = await resolve(slug, { cacheTtlMs: config.ensCacheTtlMs });
  } catch (error) {
    // Distinguished from "no SLA published" on purpose: a judge that reads an
    // ENS outage as an absent SLA would refuse claims that are perfectly valid.
    return json({ error: 'naming_layer_unavailable', detail: /** @type {Error} */ (error).message }, 503);
  }

  if (!record.sla) {
    return json({ error: 'no_sla', slug, detail: `${slug} publishes no sla record` }, 404);
  }

  // `sla` is relayed exactly as ENS holds it — a raw, unparsed string. Parsing
  // belongs to @verdikt/sla, which the proxy must not depend on, and the judge
  // needs the bytes the provider actually published rather than a re-serialised
  // copy of them.
  return json({ slug, sla: record.sla, url: record.url });
}

/**
 * The evidence envelope for one paid call, disclosed to the payer that bought
 * it and to whoever that payer authorises — in practice, GenLayer's validators
 * (docs/GenLayer.md, #82).
 *
 * Three answers are deliberately distinct, because the judge treats them
 * differently. 404 means there is nothing to judge and resolves the claim
 * `UNDETERMINED`; 401/403 mean the caller has not shown it may look; 503 means
 * the proxy is misconfigured and the claimant should come back, which the judge
 * reads as `[TRANSIENT]` rather than as a finding against anyone.
 *
 * @param {string} pathRequestId
 * @param {Request} request
 * @param {{ config: ProxyConfig, registry: Pick<RegistryReader, 'getVerdict'>, evidence: EvidenceStore|null }} deps
 */
async function handleEvidenceRead(pathRequestId, request, { config, registry, evidence }) {
  if (!evidence) {
    return json(
      { error: 'evidence_unavailable', detail: 'this proxy is not configured with an evidence store' },
      503
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pathRequestId)) {
    return json({ error: 'bad_request_id', detail: 'a request id is 32 bytes as 0x-prefixed hex' }, 400);
  }
  // Lower-cased once, here. `disclosureMessage` already lower-cases what it
  // signs, so a caller presenting the id in upper case passed the gate and
  // then missed the store — which the judge reads as "no evidence", the one
  // answer that quietly resolves a real claim UNDETERMINED.
  const requestId = pathRequestId.toLowerCase();

  const gate = await authorizeDisclosure({
    requestId,
    signature: request.headers.get(EVIDENCE_AUTH_HEADER),
    registry
  });
  if (!gate.ok) {
    return json({ error: gate.error, detail: gate.detail }, gate.status);
  }

  const envelope = await evidence.read(requestId, config.evidenceAdjudicationWindowMs);
  if (!envelope) {
    // Never cached, or the window closed. Both are "no evidence", and the
    // judge must read that as undecidable rather than as a breach — a provider
    // that loses a dispute because a cache expired is being convicted of
    // Verdikt's bookkeeping.
    return json({ error: 'no_evidence', requestId, detail: 'no evidence is cached for this request' }, 404);
  }

  return json(envelope);
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
