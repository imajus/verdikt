import { afterEach, expect, it, vi } from 'vitest';
import { initPlausible, track } from './analytics.js';

const init = vi.hoisted(() => vi.fn());
vi.mock('@plausible-analytics/tracker', () => ({ init }));

afterEach(() => { vi.unstubAllGlobals(); init.mockClear(); });

it('never throws with no config and no browser globals at all', async () => {
  await expect(initPlausible({})).resolves.toBeUndefined();
  expect(() => track('pageview')).not.toThrow();
  expect(init).not.toHaveBeenCalled();
});

it('does not import or initialize the tracker unless both env vars are set', async () => {
  await initPlausible({ VITE_PLAUSIBLE_ENDPOINT: 'https://analytics.example/api/event' });
  await initPlausible({ VITE_PLAUSIBLE_DOMAIN: 'verdikt.bond' });
  expect(init).not.toHaveBeenCalled();
});

it('initializes the tracker with the configured domain/endpoint and manual pageviews once both are set', async () => {
  await initPlausible({ VITE_PLAUSIBLE_ENDPOINT: 'https://analytics.example/api/event', VITE_PLAUSIBLE_DOMAIN: 'verdikt.bond' });
  expect(init).toHaveBeenCalledWith({ domain: 'verdikt.bond', endpoint: 'https://analytics.example/api/event', autoCapturePageviews: false });
});

it('sends events fired before the dynamically imported tracker has loaded', async () => {
  // main.js calls initPlausible() and then, synchronously, syncRoute() —
  // which tracks the first pageview while the tracker's chunk is still in
  // flight and window.plausible does not exist yet.
  const plausible = vi.fn();
  init.mockImplementation(() => { /** @type {any} */ (globalThis.window).plausible = plausible; });
  vi.stubGlobal('window', {});
  vi.stubGlobal('location', new URL('https://verdikt.bond/marketplace'));
  const ready = initPlausible({ VITE_PLAUSIBLE_ENDPOINT: 'https://analytics.example/api/event', VITE_PLAUSIBLE_DOMAIN: 'verdikt.bond' });
  track('pageview');
  expect(plausible).not.toHaveBeenCalled();
  await ready;
  // Carries the URL it was queued on, not whatever the URL is once the chunk
  // lands — the queued event must mean what it meant when it was fired.
  expect(plausible).toHaveBeenCalledWith('pageview', { u: 'https://verdikt.bond/marketplace' });
  track('Sign In');
  expect(plausible).toHaveBeenLastCalledWith('Sign In', undefined);
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
