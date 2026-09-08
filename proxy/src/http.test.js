import { describe, expect, it } from 'vitest';
import { assertRelayableUrl, forwardRequestHeaders, forwardResponseHeaders, joinUpstream } from './http.js';

describe('assertRelayableUrl', () => {
  it('accepts an ordinary public endpoint', () => {
    expect(assertRelayableUrl('https://provider.example/weather', false).hostname).toBe('provider.example');
  });

  // The `url` record is provider-authored and the proxy dials it from Verdikt's
  // own network, so without this it is a server-side-request-forgery primitive.
  it('refuses hosts only Verdikt’s network can reach', () => {
    for (const url of [
      'http://localhost:8080/x',
      'http://sub.localhost/x',
      'http://127.0.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://100.64.0.1/x', // CGNAT (100.64.0.0/10)
      'http://0.0.0.0/x',
      'http://[::1]/x'
    ]) {
      expect(() => assertRelayableUrl(url, false), url).toThrow(/private host/);
    }
  });

  // The URL parser normalises numeric IPv4 spellings, so a private address
  // dressed up as decimal/hex/octal/short-form still resolves to a private host.
  it('refuses private IPv4 no matter how it is spelled', () => {
    for (const url of [
      'http://2130706433/x', // 127.0.0.1 as a 32-bit decimal
      'http://0x7f000001/x', // 127.0.0.1 in hex
      'http://017700000001/x', // 127.0.0.1 in octal
      'http://127.1/x', // short form
      'http://0/x' // 0.0.0.0
    ]) {
      expect(() => assertRelayableUrl(url, false), url).toThrow(/private host/);
    }
  });

  // The old string guard only knew `::1`, `fc`, and `fd`. These are the IPv6
  // spellings of private hosts it let straight through — including the metadata
  // endpoint mapped into IPv6, which the parser renders in hex.
  it('refuses private IPv6, including mapped/unspecified/link-local forms', () => {
    for (const url of [
      'http://[::]/x', // unspecified
      'http://[::ffff:127.0.0.1]/x', // IPv4-mapped loopback (serialised as ::ffff:7f00:1)
      'http://[::ffff:169.254.169.254]/x', // IPv4-mapped cloud metadata
      'http://[::ffff:10.0.0.1]/x', // IPv4-mapped RFC1918
      'http://[fe80::1]/x', // link-local
      'http://[fd12:3456:789a::1]/x', // unique-local (fd)
      'http://[fc00::1]/x' // unique-local (fc)
    ]) {
      expect(() => assertRelayableUrl(url, false), url).toThrow(/private host/);
    }
  });

  it('still allows public addresses in either family', () => {
    expect(assertRelayableUrl('http://8.8.8.8/x', false).hostname).toBe('8.8.8.8');
    expect(assertRelayableUrl('http://[2606:4700:4700::1111]/x', false).hostname).toBe('[2606:4700:4700::1111]');
    expect(assertRelayableUrl('http://[::ffff:8.8.8.8]/x', false).hostname).toBe('[::ffff:808:808]');
  });

  it('allows them only when a demo explicitly opts in', () => {
    expect(assertRelayableUrl('http://localhost:8080/x', true).hostname).toBe('localhost');
  });

  it('refuses a scheme that is not http(s)', () => {
    for (const url of ['file:///etc/passwd', 'ftp://provider.example/x', 'gopher://provider.example/x']) {
      expect(() => assertRelayableUrl(url, false), url).toThrow();
    }
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertRelayableUrl('provider.example/weather', false)).toThrow(/not a URL/);
  });
});

describe('joinUpstream', () => {
  const base = new URL('https://provider.example/weather');

  it('appends the agent’s path to the provider base', () => {
    expect(joinUpstream(base, 'current', '?lat=52').toString()).toBe('https://provider.example/weather/current?lat=52');
  });

  it('handles a base that already ends in a slash', () => {
    expect(joinUpstream(new URL('https://provider.example/weather/'), 'current', '').toString()).toBe(
      'https://provider.example/weather/current'
    );
  });

  // A trailing slash is a different resource. The demo provider 308s
  // `.../slug/` to `.../slug`, so appending one turns an agent's 402 challenge
  // into a redirect it has to follow.
  it('leaves the base alone for an empty rest path, adding no trailing slash', () => {
    expect(joinUpstream(base, '', '').toString()).toBe('https://provider.example/weather');
    expect(joinUpstream(base, '', '?a=1').toString()).toBe('https://provider.example/weather?a=1');
  });

  // A real upstream server sees the raw path a client sent, so this is
  // reachable in production even though the URL parser used to build a
  // request in a router-level test collapses dot-segments first.
  it('refuses a path that climbs out of the provider’s own prefix', () => {
    for (const rest of ['../admin', '../../admin', 'a/../../admin']) {
      expect(() => joinUpstream(base, rest, ''), rest).toThrow(/escapes/);
    }
  });

  it('leaves an encoded slash encoded rather than treating it as a separator', () => {
    expect(joinUpstream(base, '..%2f..%2fadmin', '').pathname).toBe('/weather/..%2f..%2fadmin');
  });
});

describe('header forwarding', () => {
  it('drops hop-by-hop headers and the ones fetch recomputes', () => {
    const forwarded = forwardRequestHeaders({
      host: 'weather.verdikt.bond',
      connection: 'keep-alive',
      'content-length': '12',
      'accept-encoding': 'gzip',
      'x-payment': 'abc',
      accept: 'application/json'
    });
    expect(forwarded).toEqual({ 'x-payment': 'abc', accept: 'application/json' });
  });

  it('drops framing headers fetch has already resolved on the way back', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '99',
      connection: 'close'
    });
    expect(forwardResponseHeaders(headers)).toEqual({ 'content-type': 'application/json' });
  });
});
