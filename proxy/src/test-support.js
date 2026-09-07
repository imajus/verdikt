// Test-only. `handleRequest` takes a `Request` and returns a `Response`;
// `call()` builds the first from options close to what the old Fastify
// `app.inject({ method, url, headers, payload })` took, and reads the second
// back into the same `{ statusCode, headers, body, json() }` shape the tests
// were written against — so the migration off Fastify touches this file
// instead of every assertion in every test.
//
// `headers.host` sets the target hostname rather than being sent as a literal
// header: routing reads the hostname off the URL (router.js), and some `fetch`
// implementations refuse to let a constructed `Request` carry a `Host` header
// at all.

import { handleRequest } from './router.js';

/**
 * @param {ProxyDeps} deps
 * @param {{ method?: string, url?: string, headers?: Record<string,string>, payload?: unknown }} [options]
 */
export async function call(deps, { method = 'GET', url = '/weather/current?lat=52', headers = {}, payload } = {}) {
  const { host = 'proxy.local', ...rest } = headers;
  const target = new URL(url, `https://${host}`);
  const body = payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload);
  const response = await handleRequest(new Request(target, { method, headers: rest, body }), deps);
  const text = await response.text();
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: text,
    json: () => JSON.parse(text)
  };
}
