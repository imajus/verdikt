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
 * The agent's request body, as hex, for the trip through the enclave trigger.
 *
 * Hex rather than base64 or a plain string: the trigger input is JSON, so the
 * body cannot travel as bytes, and it is not necessarily text — a provider may
 * take any content type. The workflow bundles to WASM, where viem's
 * `hexToBytes` is already present and `atob` is not guaranteed to be.
 *
 * @param {ArrayBuffer|undefined} body
 * @returns {string|null} `0x`-prefixed hex, or null when there is no body
 */
export function bodyToHex(body) {
  if (!body || body.byteLength === 0) return null;
  let out = '0x';
  for (const byte of new Uint8Array(body)) out += byte.toString(16).padStart(2, '0');
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

// --- SSRF host classification ------------------------------------------------
//
// The provider authors the `url` record and the proxy dials it from Verdikt's
// own network, so an unconstrained host is a server-side-request-forgery
// primitive: it can reach loopback, the RFC1918 ranges, the cloud metadata
// endpoint (169.254.169.254), and every one of their IPv6 spellings.
//
// This classifies the *parsed* address, not the raw text. `new URL` has already
// normalised the host — IPv4 in any spelling (decimal `2130706433`, hex, octal,
// short `127.1`) to dotted decimal, IPv6 to a bracketed compressed form — and
// it renders an IPv4-mapped address in hex (`[::ffff:7f00:1]`, not
// `[::ffff:127.0.0.1]`), so an IPv6 literal has to be expanded to bytes rather
// than string-matched. The old regex only caught a handful of IPv4 prefixes and
// `::1`/`fc`/`fd`, letting mapped/unspecified/link-local/CGNAT through.
//
// It is a *literal-address* guard by design. It does not resolve DNS, so a
// public name that resolves to a private IP still passes (a DNS-rebinding /
// TOCTOU gap the demo accepts, Specification.md §4); literal NAT64/translation
// prefixes are likewise out of scope. What it must not do — and now does not —
// is wave a private address through because it was written in IPv6.

/** @param {number[]} octets 4 bytes @returns {boolean} */
function isPrivateIPv4([a, b, c, d]) {
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // limited broadcast
  return false;
}

/** Dotted-quad → 4 octets, or null. @param {string} host @returns {number[]|null} */
function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.some((n) => Number.isNaN(n) || n > 255) ? null : octets;
}

/** Bracket-stripped IPv6 → 16 bytes, or null. @param {string} host @returns {number[]|null} */
function parseIPv6(host) {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  /** @param {string} part @returns {number[]|null} */
  const toBytes = (part) => {
    if (part === '') return [];
    const groups = part.split(':');
    const bytes = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.includes('.')) {
        // A trailing embedded IPv4 (`::ffff:1.2.3.4`) is only valid last.
        if (i !== groups.length - 1) return null;
        const v4 = parseIPv4(g);
        if (!v4) return null;
        bytes.push(...v4);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(g)) {
        const n = parseInt(g, 16);
        bytes.push(n >> 8, n & 0xff);
      } else {
        return null;
      }
    }
    return bytes;
  };
  const head = toBytes(halves[0]);
  const tail = halves.length === 2 ? toBytes(halves[1]) : [];
  if (head === null || tail === null) return null;
  const gap = 16 - head.length - tail.length;
  // With `::` the gap is the compressed zero run (>= 0); without it the two
  // halves must already total 16 bytes exactly.
  if (halves.length === 2 ? gap < 0 : gap !== 0) return null;
  const bytes = [...head, ...new Array(gap).fill(0), ...tail];
  return bytes.length === 16 ? bytes : null;
}

/** @param {number[]} b 16 bytes @returns {boolean} */
function isPrivateIPv6(b) {
  /** @param {number} n */
  const zeroUpTo = (n) => b.slice(0, n).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d — classify the embedded IPv4.
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIPv4(b.slice(12));
  // ::, ::1, and the deprecated IPv4-compatible ::a.b.c.d all live in ::/96;
  // classifying the low 32 bits covers unspecified and loopback (both in 0/8).
  if (zeroUpTo(12)) return isPrivateIPv4(b.slice(12));
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

/**
 * Hosts a provider must not be able to point Verdikt's proxy at. `hostname` is
 * the already-normalised `URL.hostname`: an IPv6 literal is bracketed.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateHost(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const bytes = parseIPv6(hostname.slice(1, -1));
    // An IPv6 literal we cannot parse is refused rather than trusted.
    return bytes ? isPrivateIPv6(bytes) : true;
  }
  const v4 = parseIPv4(hostname);
  if (v4) return isPrivateIPv4(v4);
  // A DNS name: not resolvable here, so block only the loopback names RFC 6761
  // reserves and let the resolver decide the rest.
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost');
}

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
  if (!allowPrivate && isPrivateHost(url.hostname)) {
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
  // An empty rest means "the base itself". Appending a slash would ask for a
  // different resource: the demo provider answers `.../slug/` with a 308 to
  // `.../slug`, so the agent would get a redirect instead of its 402 challenge.
  if (rest === '') {
    const target = new URL(base.toString());
    target.search = search;
    return target;
  }
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
