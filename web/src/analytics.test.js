import { afterEach, expect, it, vi } from 'vitest';
import { initPlausible, track } from './analytics.js';

afterEach(() => vi.unstubAllGlobals());

it('never throws with no browser globals at all', () => {
  expect(() => track('pageview')).not.toThrow();
  expect(() => initPlausible({})).not.toThrow();
});

it('does not touch the DOM unless both env vars are set', () => {
  const append = vi.fn();
  vi.stubGlobal('document', { createElement: vi.fn(), head: { append } });
  initPlausible({ VITE_PLAUSIBLE_SRC: 'https://analytics.example/script.js' });
  initPlausible({ VITE_PLAUSIBLE_DOMAIN: 'verdikt.bond' });
  expect(append).not.toHaveBeenCalled();
});

it('injects a deferred script tagged with the configured domain once both are set', () => {
  const script = /** @type {any} */ ({ dataset: {} });
  const createElement = vi.fn(() => script);
  const append = vi.fn();
  vi.stubGlobal('document', { createElement, head: { append } });
  initPlausible({ VITE_PLAUSIBLE_SRC: 'https://analytics.example/script.js', VITE_PLAUSIBLE_DOMAIN: 'verdikt.bond' });
  expect(createElement).toHaveBeenCalledWith('script');
  expect(script).toMatchObject({ defer: true, src: 'https://analytics.example/script.js', dataset: { domain: 'verdikt.bond' } });
  expect(append).toHaveBeenCalledWith(script);
});

it('calls window.plausible when present, and no-ops when it is not', () => {
  expect(() => track('pageview')).not.toThrow();
  const plausible = vi.fn();
  vi.stubGlobal('window', { plausible });
  track('pageview');
  track('Onboarding Step', { props: { step: 'claim' } });
  expect(plausible).toHaveBeenCalledWith('pageview', undefined);
  expect(plausible).toHaveBeenCalledWith('Onboarding Step', { props: { step: 'claim' } });
});
