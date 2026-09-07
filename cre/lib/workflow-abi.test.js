// The aggregate workflow keeps its own copy of the registry's event
// signatures, because a CRE workflow bundles to WASM and cannot reach the SDK's
// ABI through the same path the dashboard does.
//
// A second copy of a signature is a thing that drifts, and this particular
// drift is invisible. The signature is not a decode hint — it is the topic the
// log filter matches on. Add a field to `VerdictWritten` and its topic hash
// changes; the stale filter then matches nothing, the window comes back empty,
// and an empty window scores 1000. So the failure is not an error, it is every
// service reporting a perfect record. That happened once, and the only reason
// it was caught is that a service known to have failed came back at 1000.
//
// The two literals are compared as text rather than as computed topics, so this
// needs nothing viem-shaped in the CRE package: identical signature strings
// give identical topics, which is the whole property at stake.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCES = {
  workflow: new URL('../workflows/aggregate/workflow.ts', import.meta.url),
  sdk: new URL('../../packages/sdk/arc.js', import.meta.url)
};

/**
 * Every `event Name(...)` signature declared as a string literal in a file,
 * keyed by event name and normalised for whitespace.
 *
 * @param {URL} source
 * @returns {Record<string, string>}
 */
function declaredEvents(source) {
  const text = readFileSync(source, 'utf8');
  /** @type {Record<string, string>} */
  const found = {};
  for (const match of text.matchAll(/'(event (\w+)\([^']*\))'/g)) {
    found[match[2]] = match[1].replace(/\s+/g, ' ');
  }
  return found;
}

describe('the aggregate workflow reads the events the registry actually emits', () => {
  const workflow = declaredEvents(SOURCES.workflow);
  const sdk = declaredEvents(SOURCES.sdk);

  it('finds signatures on both sides, so a rename cannot make this vacuous', () => {
    expect(Object.keys(workflow).length).toBeGreaterThan(0);
    expect(Object.keys(sdk)).toEqual(expect.arrayContaining(Object.keys(workflow)));
  });

  // `ServiceRegistered` drifting would empty the listing rather than flatter
  // it, but it is the same bug, so both are pinned.
  for (const eventName of ['VerdictWritten', 'ServiceRegistered']) {
    it(`declares ${eventName} exactly as the SDK does`, () => {
      expect(workflow[eventName], `${eventName} is not declared in the aggregate workflow`).toBeDefined();
      expect(workflow[eventName], `${eventName} drifted between the workflow and the SDK`).toBe(sdk[eventName]);
    });
  }
});
