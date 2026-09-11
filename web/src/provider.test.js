import { describe, expect, it } from 'vitest';
import { resolveProviderConsole } from './provider.js';

const OWNER = '0xA11ce00000000000000000000000000000000001';
const OTHER = '0xB0b0000000000000000000000000000000000002';

/** @param {string} slug @param {string} provider */
const listing = (slug, provider) => /** @type {any} */ ({ slug, provider });

const services = [listing('weather', OWNER), listing('other', OTHER), listing('tides', OWNER)];

describe('resolveProviderConsole', () => {
  it('narrows to the services owned by the address', () => {
    const { owned } = resolveProviderConsole(services, OWNER);
    expect(owned.map((s) => s.slug)).toEqual(['weather', 'tides']);
  });
  it('matches the address case-insensitively', () => {
    expect(resolveProviderConsole(services, OWNER.toLowerCase()).owned).toHaveLength(2);
  });
  it('targets the first owned listing', () => {
    expect(resolveProviderConsole(services, OWNER).target?.slug).toBe('weather');
  });
  it('owns nothing, and targets nothing, for an address with no services', () => {
    const { owned, target } = resolveProviderConsole(services, '0xdead00000000000000000000000000000000dead');
    expect(owned).toEqual([]);
    expect(target).toBeNull();
  });
  // The defect this module was rewritten to remove: with no address in the
  // path it used to fall back to the connected wallet, so /provider rendered
  // different people's data — or, connected to nobody, the marketplace.
  it('selects nobody when there is no address, whoever is connected', () => {
    const { owned, target } = resolveProviderConsole(services, null);
    expect(owned).toEqual([]);
    expect(target).toBeNull();
  });
});
