// Relay plumbing: which headers cross, and what an upstream URL is allowed to be.

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) plus the ones `fetch` recomputes.
 * `accept-encoding` is dropped so the upstream answers in something fetch will
 * decode; `content-length` because the body is re-framed.
 */
const DROP_FROM_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding'
]);

/** `fetch` has already decoded the body, so the upstream's framing headers are lies downstream. */
const DROP_FROM_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length'
]);

/**
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {Record<string, string>}
 */
export function forwardRequestHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (DROP_FROM_REQUEST.has(name.toLowerCase())) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * @param {Headers} headers
 * @returns {Record<string, string>}
 */
export function forwardResponseHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  headers.forEach((value, name) => {
    if (DROP_FROM_RESPONSE.has(name.toLowerCase())) return;
    out[name] = value;
  });
  return out;
}

/** Hosts a provider must not be able to point Verdikt's proxy at. */
const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i;

/**
 * The provider authored this URL and the proxy dials it from Verdikt's own
 * network, so it is an SSRF primitive unless it is constrained. Refusing here
 * — before any request is made — keeps a hostile `url` record from reaching
 * anything the proxy can reach but the public internet cannot.
 *
 * @param {string} raw
 * @param {boolean} allowPrivate
 * @returns {URL}
 */
export function assertRelayableUrl(raw, allowPrivate) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`upstream url is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`upstream url must be http(s), got ${url.protocol}`);
  }
  if (!allowPrivate && PRIVATE_HOST.test(url.hostname)) {
    throw new Error(`upstream url resolves to a private host: ${url.hostname}`);
  }
  return url;
}

/**
 * Join the provider's base URL with the rest of the agent's path, without
 * letting the path escape the base.
 *
 * @param {URL} base
 * @param {string} rest path after the slug, no leading slash
 * @param {string} search including `?`, or empty
 * @returns {URL}
 */
export function joinUpstream(base, rest, search) {
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const target = new URL(`${basePath}${rest}`, base);
  // `new URL` normalises `..`, so a path like `a/../../admin` would otherwise
  // land outside the provider's own prefix.
  if (!target.pathname.startsWith(basePath) && target.pathname !== base.pathname) {
    throw new Error('request path escapes the provider base path');
  }
  target.search = search;
  return target;
}
