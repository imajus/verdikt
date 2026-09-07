import { afterEach, describe, expect, it } from 'vitest';
import { env } from './env.js';

const KEY = 'VERDIKT_ENV_TEST';
afterEach(() => {
  delete process.env[KEY];
});

describe('env', () => {
  it('returns a set value', () => {
    process.env[KEY] = 'value';
    expect(env(KEY)).toBe('value');
  });

  // The bug this exists for: `.env.example` ships bare keys, so a copied file
  // is full of empty strings. `??` does not fall through on those, so a
  // perfectly good default never runs — which took the proxy down with an error
  // insisting the registry was not deployed while the file held its address.
  it('treats an empty or whitespace value as unset, so a default still applies', () => {
    for (const blank of ['', '   ', '\t', '\n']) {
      process.env[KEY] = blank;
      expect(env(KEY), JSON.stringify(blank)).toBeUndefined();
      expect(env(KEY) ?? 'fallback').toBe('fallback');
    }
  });

  it('returns undefined for a variable that was never set', () => {
    expect(env(KEY)).toBeUndefined();
  });

  it('trims, so a stray newline from a copied file cannot become part of an address', () => {
    process.env[KEY] = '  0xabc \n';
    expect(env(KEY)).toBe('0xabc');
  });
});
