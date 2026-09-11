import { describe, expect, it } from 'vitest';
import { MARKETPLACE_PATH, parseRoute, providerUrl, serviceUrl, titleFor } from './router.js';

describe('parseRoute', () => {
  it('reads the landing path', () => {
    expect(parseRoute(new URL('https://verdikt.example/'))).toEqual({ view: 'landing', slug: null, address: null, canonicalPath: '/' });
  });
  it('reads the marketplace path', () => {
    expect(parseRoute(new URL('https://verdikt.example/marketplace'))).toEqual({ view: 'marketplace', slug: null, address: null, canonicalPath: '/marketplace' });
  });
  it('reads a service path', () => {
    expect(parseRoute(new URL('https://verdikt.example/services/weather'))).toEqual({ view: 'service', slug: 'weather', address: null, canonicalPath: '/services/weather' });
  });
  it('decodes an encoded slug', () => {
    expect(parseRoute(new URL('https://verdikt.example/services/weather%20api')).slug).toBe('weather api');
  });
  it('reads the own provider console path', () => {
    expect(parseRoute(new URL('https://verdikt.example/provider'))).toEqual({ view: 'provider', slug: null, address: null, canonicalPath: '/provider' });
  });
  it('reads a shared provider path', () => {
    expect(parseRoute(new URL('https://verdikt.example/provider/0xAaAa'))).toEqual({ view: 'provider', slug: null, address: '0xAaAa', canonicalPath: '/provider/0xAaAa' });
  });
  it('reads the how, terms and privacy paths', () => {
    expect(parseRoute(new URL('https://verdikt.example/how')).view).toBe('how');
    expect(parseRoute(new URL('https://verdikt.example/terms')).view).toBe('terms');
    expect(parseRoute(new URL('https://verdikt.example/privacy')).view).toBe('privacy');
  });
  it('tolerates a trailing slash', () => {
    expect(parseRoute(new URL('https://verdikt.example/marketplace/')).view).toBe('marketplace');
  });
  it('falls back to the marketplace, with a redirect, for an unrecognised path', () => {
    const route = parseRoute(new URL('https://verdikt.example/nonsense'));
    expect(route.view).toBe('marketplace');
    expect(route.canonicalPath).toBe(MARKETPLACE_PATH);
  });
  it('rewrites the legacy ?provider= deep link forward, regardless of path', () => {
    const route = parseRoute(new URL('https://verdikt.example/?provider=0xAaAa'));
    expect(route).toEqual({ view: 'provider', slug: null, address: '0xAaAa', canonicalPath: '/provider/0xAaAa' });
  });
});

describe('serviceUrl / providerUrl', () => {
  it('builds a service path, encoding the slug', () => {
    expect(serviceUrl('weather api')).toBe('/services/weather%20api');
  });
  it('builds a provider path', () => {
    expect(providerUrl('0xAaAa')).toBe('/provider/0xAaAa');
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
});
