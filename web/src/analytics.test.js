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

it('calls window.plausible when present, and no-ops when it is not', () => {
  expect(() => track('pageview')).not.toThrow();
  const plausible = vi.fn();
  vi.stubGlobal('window', { plausible });
  track('pageview');
  track('Onboarding Step', { props: { step: 'claim' } });
  expect(plausible).toHaveBeenCalledWith('pageview', undefined);
  expect(plausible).toHaveBeenCalledWith('Onboarding Step', { props: { step: 'claim' } });
});
