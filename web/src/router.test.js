import { describe, expect, it } from 'vitest';
import { MARKETPLACE_PATH, PROVIDER_PATH, parseRoute, providerUrl, serviceUrl, titleFor } from './router.js';

const OWNER = '0xA11ce00000000000000000000000000000000001';

describe('parseRoute', () => {
  it('reads the landing path', () => {
    expect(parseRoute(new URL('https://verdikt.example/'))).toEqual({ view: 'landing', slug: null, address: null, rejected: null, canonicalPath: '/' });
  });
  it('reads the marketplace path', () => {
    expect(parseRoute(new URL('https://verdikt.example/marketplace'))).toEqual({ view: 'marketplace', slug: null, address: null, rejected: null, canonicalPath: '/marketplace' });
  });
  it('reads a service path', () => {
    expect(parseRoute(new URL('https://verdikt.example/services/weather'))).toEqual({ view: 'service', slug: 'weather', address: null, rejected: null, canonicalPath: '/services/weather' });
  });
  it('decodes an encoded slug', () => {
    expect(parseRoute(new URL('https://verdikt.example/services/weather%20api')).slug).toBe('weather api');
  });
  it('reads the address-less provider path', () => {
    expect(parseRoute(new URL('https://verdikt.example/provider'))).toEqual({ view: 'provider', slug: null, address: null, rejected: null, canonicalPath: '/provider' });
  });
  it('reads a shared provider path', () => {
    expect(parseRoute(new URL(`https://verdikt.example/provider/${OWNER}`))).toEqual({ view: 'provider', slug: null, address: OWNER, rejected: null, canonicalPath: `/provider/${OWNER}` });
  });
  // The whole point of validating here: past parseRoute, `address` is either
  // a real address or null, so no consumer has to ask again and none of them
  // can be handed a path segment to look up as if it were one.
  it('selects no provider when the path segment is not an address', () => {
    const route = parseRoute(new URL('https://verdikt.example/provider/foo'));
    expect(route).toEqual({ view: 'provider', slug: null, address: null, rejected: 'foo', canonicalPath: '/provider/foo' });
  });
  it('rejects an address of the wrong length or alphabet', () => {
    expect(parseRoute(new URL('https://verdikt.example/provider/0xAaAa')).address).toBeNull();
    expect(parseRoute(new URL(`https://verdikt.example/provider/${OWNER}00`)).address).toBeNull();
    expect(parseRoute(new URL(`https://verdikt.example/provider/${OWNER.slice(0, -1)}z`)).address).toBeNull();
  });
  it('accepts an address in any case, unchanged', () => {
    expect(parseRoute(new URL(`https://verdikt.example/provider/${OWNER.toLowerCase()}`)).address).toBe(OWNER.toLowerCase());
  });
  it('reads the how, terms and privacy paths', () => {
    expect(parseRoute(new URL('https://verdikt.example/how')).view).toBe('how');
    expect(parseRoute(new URL('https://verdikt.example/terms')).view).toBe('terms');
    expect(parseRoute(new URL('https://verdikt.example/privacy')).view).toBe('privacy');
  });
  it('reads the register path', () => {
    expect(parseRoute(new URL('https://verdikt.example/register'))).toEqual({ view: 'register', slug: null, address: null, rejected: null, canonicalPath: '/register' });
  });
  it('tolerates a trailing slash', () => {
    expect(parseRoute(new URL('https://verdikt.example/marketplace/')).view).toBe('marketplace');
  });
  it('falls back to the marketplace, with a redirect, for an unrecognised path', () => {
    const route = parseRoute(new URL('https://verdikt.example/nonsense'));
    expect(route.view).toBe('marketplace');
    expect(route.canonicalPath).toBe(MARKETPLACE_PATH);
  });
  it('falls back to the marketplace for a malformed percent-encoded service path', () => {
    const route = parseRoute(new URL('https://verdikt.example/services/%E0%A4%A'));
    expect(route).toEqual({ view: 'marketplace', slug: null, address: null, rejected: null, canonicalPath: MARKETPLACE_PATH });
  });
  it('rewrites the legacy ?provider= deep link forward, regardless of path', () => {
    const route = parseRoute(new URL(`https://verdikt.example/?provider=${OWNER}`));
    expect(route).toEqual({ view: 'provider', slug: null, address: OWNER, rejected: null, canonicalPath: `/provider/${OWNER}` });
  });
  // Nothing of the junk URL survives the rewrite, so there would be nothing
  // left on screen for a message about it to refer to.
  it('drops a legacy ?provider= value that is not an address without reporting it', () => {
    const route = parseRoute(new URL('https://verdikt.example/?provider=foo'));
    expect(route).toEqual({ view: 'provider', slug: null, address: null, rejected: null, canonicalPath: PROVIDER_PATH });
  });
});

describe('serviceUrl / providerUrl', () => {
  it('builds a service path, encoding the slug', () => {
    expect(serviceUrl('weather api')).toBe('/services/weather%20api');
  });
  it('builds a provider path', () => {
    expect(providerUrl(OWNER)).toBe(`/provider/${OWNER}`);
  });
});

describe('titleFor', () => {
  it('titles the static views', () => {
    expect(titleFor(parseRoute(new URL('https://verdikt.example/marketplace')))).toBe('Marketplace — Verdikt');
    expect(titleFor(parseRoute(new URL('https://verdikt.example/how')))).toBe('How it works — Verdikt');
  });
  it('titles a service page with its slug', () => {
    expect(titleFor(parseRoute(new URL('https://verdikt.example/services/weather')))).toBe('weather — Verdikt');
  });
  it('titles both provider states the same', () => {
    expect(titleFor(parseRoute(new URL('https://verdikt.example/provider')))).toBe('Provider — Verdikt');
    expect(titleFor(parseRoute(new URL(`https://verdikt.example/provider/${OWNER}`)))).toBe('Provider — Verdikt');
  });
  it('titles the register page', () => {
    expect(titleFor(parseRoute(new URL('https://verdikt.example/register')))).toBe('List a service — Verdikt');
  });
});
