import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, effectiveTheme, savePreference, savedPreference, systemTheme, watchSystemTheme } from './theme.js';

/** A localStorage-shaped in-memory stub — jsdom is not part of this project's test setup. */
function fakeLocalStorage() {
  /** @type {Map<string, string>} */
  const store = new Map();
  return {
    getItem: (/** @type {string} */ key) => store.get(key) ?? null,
    setItem: (/** @type {string} */ key, /** @type {string} */ value) => store.set(key, String(value)),
    removeItem: (/** @type {string} */ key) => store.delete(key)
  };
}

/** @param {boolean} matches */
function fakeMatchMedia(matches) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const mediaQueryList = {
    matches,
    addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => listeners.add(fn),
    removeEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => listeners.delete(fn)
  };
  return { matchMedia: () => mediaQueryList, mediaQueryList, fire: () => listeners.forEach((fn) => fn()) };
}

function fakeDocument() {
  const documentElement = { dataset: /** @type {Record<string, string>} */ ({}), classList: { toggle: vi.fn() } };
  const meta = { setAttribute: vi.fn() };
  return { documentElement, meta, querySelector: () => meta };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('savedPreference', () => {
  it('returns the stored value for an explicit light or dark override', () => {
    localStorage.setItem('verdikt-theme', 'dark');
    expect(savedPreference()).toBe('dark');
    localStorage.setItem('verdikt-theme', 'light');
    expect(savedPreference()).toBe('light');
  });
  it('returns system when nothing is stored', () => {
    expect(savedPreference()).toBe('system');
  });
  it('returns system for a corrupt stored value', () => {
    localStorage.setItem('verdikt-theme', 'sepia');
    expect(savedPreference()).toBe('system');
  });
  it('returns system when localStorage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(savedPreference()).toBe('system');
  });
});

describe('systemTheme and effectiveTheme', () => {
  it('reads the OS preference through matchMedia', () => {
    vi.stubGlobal('matchMedia', fakeMatchMedia(true).matchMedia);
    expect(systemTheme()).toBe('dark');
    vi.stubGlobal('matchMedia', fakeMatchMedia(false).matchMedia);
    expect(systemTheme()).toBe('light');
  });
  it('passes an explicit preference through unchanged', () => {
    expect(effectiveTheme('light')).toBe('light');
    expect(effectiveTheme('dark')).toBe('dark');
  });
  it('resolves system through the OS preference', () => {
    vi.stubGlobal('matchMedia', fakeMatchMedia(true).matchMedia);
    expect(effectiveTheme('system')).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('paints the DOM attribute, class toggles, and theme-color meta for the given theme', () => {
    const fake = fakeDocument();
    vi.stubGlobal('document', fake);
    applyTheme('dark');
    expect(fake.documentElement.dataset.theme).toBe('dark');
    expect(fake.documentElement.classList.toggle).toHaveBeenCalledWith('wa-light', false);
    expect(fake.documentElement.classList.toggle).toHaveBeenCalledWith('wa-dark', true);
    expect(fake.meta.setAttribute).toHaveBeenCalledWith('content', '#141310');
  });
});

describe('savePreference', () => {
  it('removes the storage key for system and applies the resolved OS theme', () => {
    vi.stubGlobal('document', fakeDocument());
    vi.stubGlobal('matchMedia', fakeMatchMedia(true).matchMedia);
    localStorage.setItem('verdikt-theme', 'light');
    savePreference('system');
    expect(localStorage.getItem('verdikt-theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
  it('stores an explicit override and applies it directly', () => {
    vi.stubGlobal('document', fakeDocument());
    savePreference('dark');
    expect(localStorage.getItem('verdikt-theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('watchSystemTheme', () => {
  it('subscribes to matchMedia changes and the unsubscribe removes the listener', () => {
    const fake = fakeMatchMedia(false);
    vi.stubGlobal('matchMedia', fake.matchMedia);
    const callback = vi.fn();
    const unsubscribe = watchSystemTheme(callback);
    fake.fire();
    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
    fake.fire();
    expect(callback).toHaveBeenCalledOnce();
  });
});
