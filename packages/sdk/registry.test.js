import { describe, expect, it } from 'vitest';
import {
  OUTCOME_ORDINAL,
  STATUS_ORDINAL,
  outcomeFromOrdinal,
  outcomeToOrdinal,
  serviceIdOf,
  statusFromOrdinal
} from './registry.js';

describe('outcome and status ordinals', () => {
  // Mirrored in IVerdiktRegistry.Outcome / .Status. Changing one side without
  // the other silently reclassifies a FAIL as a PASS.
  it('pins the ABI ordinals', () => {
    expect(OUTCOME_ORDINAL).toEqual({ PASS: 0, FAIL: 1, DOWN: 2 });
    expect(STATUS_ORDINAL).toEqual({ NONE: 0, ACTIVE: 1, SUSPENDED: 2, DEREGISTERED: 3 });
  });

  it('round-trips every outcome and status', () => {
    for (const [name, ordinal] of Object.entries(OUTCOME_ORDINAL)) {
      expect(outcomeFromOrdinal(ordinal)).toBe(name);
      expect(outcomeToOrdinal(/** @type {SlaOutcome} */ (name))).toBe(ordinal);
    }
    for (const [name, ordinal] of Object.entries(STATUS_ORDINAL)) {
      expect(statusFromOrdinal(ordinal)).toBe(name);
    }
  });

  it('refuses an ordinal outside the enum rather than guessing', () => {
    expect(() => outcomeFromOrdinal(3)).toThrow();
    expect(() => outcomeFromOrdinal(-1)).toThrow();
    expect(() => statusFromOrdinal(4)).toThrow();
    expect(() => outcomeToOrdinal(/** @type {SlaOutcome} */ ('FAIL_CONFORMANCE'))).toThrow();
  });
});

describe('serviceIdOf', () => {
  /**
   * The same two vectors `contracts/test/VerdiktRegistry.t.sol` asserts against
   * `IVerdiktRegistry.serviceIdOf`. If these ever diverge, a service's Arc id
   * stops matching its ENS subname and its route.
   */
  it('agrees with the contract on the shared vectors', () => {
    expect(serviceIdOf('weather')).toBe('0x00840d14970f593887dc91256f2e2f1380aa176569b6c84f16d7f2ced5965666');
    expect(serviceIdOf('weather-lite')).toBe('0x899bec1a6fac1010f453e04f5b2827fdd8a3eeeabd5f39a1c54f9539a116a887');
  });

  it('rejects slugs the registry would reject', () => {
    for (const slug of ['', 'Weather', 'weather.eth', 'weather_x', '-weather', 'weather-', 'wéather', 'a'.repeat(64)]) {
      expect(() => serviceIdOf(slug), slug).toThrow();
    }
  });

  it('accepts the labels a provider can actually route and name', () => {
    for (const slug of ['a', 'weather', 'weather-lite', 'x1', 'a'.repeat(63)]) {
      expect(serviceIdOf(slug), slug).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});
