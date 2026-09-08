import { describe, expect, it } from 'vitest';
import { readRoute, withProvider, withService, withView } from './router.js';

describe('readRoute', () => {
  it('defaults to the marketplace view with nothing selected', () => {
    expect(readRoute(new URL('https://verdikt.example/'))).toEqual({ view: 'marketplace', service: null, provider: null });
  });

  it('reads an explicit view, service and provider', () => {
    const route = readRoute(new URL('https://verdikt.example/?view=provider&service=weather&provider=0xAaAa'));
    expect(route).toEqual({ view: 'provider', service: 'weather', provider: '0xAaAa' });
  });

  it('treats a bare ?provider= link as the provider view, unchanged from today', () => {
    // The existing public deep link — must keep working with no ?view= at all.
    const route = readRoute(new URL('https://verdikt.example/?provider=0xAaAa'));
    expect(route).toEqual({ view: 'provider', service: null, provider: '0xAaAa' });
  });

  it('falls back to the marketplace view for an unrecognised ?view=', () => {
    const route = readRoute(new URL('https://verdikt.example/?view=nonsense'));
    expect(route.view).toBe('marketplace');
  });
});

describe('withService / withProvider / withView', () => {
  it('withService sets ?service= and preserves the current view, without mutating the input', () => {
    const input = new URL('https://verdikt.example/?view=marketplace');
    const next = withService(input, 'weather');
    expect(next.searchParams.get('service')).toBe('weather');
    expect(next.searchParams.get('view')).toBe('marketplace');
    expect(input.searchParams.get('service')).toBeNull();
  });

  it('withProvider sets ?provider= and ?view=provider', () => {
    const next = withProvider(new URL('https://verdikt.example/'), '0xAaAa');
    expect(next.searchParams.get('provider')).toBe('0xAaAa');
    expect(next.searchParams.get('view')).toBe('provider');
  });

  it('withView replaces the view without disturbing service/provider', () => {
    const next = withView(new URL('https://verdikt.example/?service=weather'), 'how');
    expect(next.searchParams.get('view')).toBe('how');
    expect(next.searchParams.get('service')).toBe('weather');
  });
});
