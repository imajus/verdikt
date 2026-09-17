// EvidenceCache and its client, tested as plain classes — no Workers runtime,
// same as pending-do.test.js next door. The fake state below is a Map plus an
// alarm slot, which is the whole of the storage surface this class uses.
//
// What these cover that evidence.test.js cannot: the Map-backed store is a
// second implementation of the same contract, and the pair only stay
// interchangeable if both are held to it.

import { describe, expect, it, vi } from 'vitest';
import { EvidenceCache, createDurableObjectEvidenceStore } from './evidence-do.js';

const REQUEST_ID = `0x${'ab'.repeat(32)}`;

/** @returns {EvidenceEnvelope} */
const envelope = () => ({
  requestId: REQUEST_ID,
  slug: 'weather',
  request: { method: 'GET', url: 'https://provider.example/current', body: null },
  response: { status: 200, contentType: 'application/json', body: '{"t":12}', bodyEncoding: 'utf8', bodyTruncated: false },
  cachedAt: 1789000000
});

function fakeState() {
  /** @type {Map<string, unknown>} */
  const values = new Map();
  /** @type {{ alarm: number|null }} */
  const alarms = { alarm: null };
  return {
    alarms,
    values,
    state: {
      storage: {
        get: async (/** @type {string} */ key) => values.get(key),
        put: async (/** @type {Record<string, unknown>} */ entries) => {
          for (const [key, value] of Object.entries(entries)) values.set(key, value);
        },
        deleteAll: async () => values.clear(),
        setAlarm: async (/** @type {number} */ at) => {
          alarms.alarm = at;
        }
      }
    }
  };
}

/** @returns {{ namespace: DurableObjectNamespace, instances: Map<string, EvidenceCache> }} */
function fakeNamespace() {
  /** @type {Map<string, EvidenceCache>} */
  const instances = new Map();
  const namespace = {
    idFromName: (/** @type {string} */ name) => name,
    get: (/** @type {unknown} */ id) => {
      const key = /** @type {string} */ (id);
      if (!instances.has(key)) instances.set(key, new EvidenceCache(fakeState().state));
      const instance = /** @type {EvidenceCache} */ (instances.get(key));
      return { fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => instance.fetch(new Request(url, init)) };
    }
  };
  return { namespace, instances };
}

describe('EvidenceCache', () => {
  it('stores an envelope and hands it back', async () => {
    const { state } = fakeState();
    const cache = new EvidenceCache(state);
    await cache.fetch(new Request('http://x/store', { method: 'POST', body: JSON.stringify({ envelope: envelope(), ttlMs: 60_000 }) }));

    const response = await cache.fetch(new Request('http://x/read', { method: 'POST', body: JSON.stringify({ adjudicationTtlMs: 60_000 }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ envelope: envelope() });
  });

  it('404s before anything is stored', async () => {
    const { state } = fakeState();
    const cache = new EvidenceCache(state);
    const response = await cache.fetch(new Request('http://x/read', { method: 'POST', body: JSON.stringify({ adjudicationTtlMs: 1 }) }));
    expect(response.status).toBe(404);
  });

  // An alarm can fire late, and serving an envelope because the cleanup has not
  // run yet would make the window advisory rather than enforced.
  it('refuses an expired envelope even if the alarm has not fired', async () => {
    const { state } = fakeState();
    const cache = new EvidenceCache(state);
    vi.useFakeTimers();
    try {
      await cache.fetch(new Request('http://x/store', { method: 'POST', body: JSON.stringify({ envelope: envelope(), ttlMs: 1000 }) }));
      vi.advanceTimersByTime(1001);
      const response = await cache.fetch(new Request('http://x/read', { method: 'POST', body: JSON.stringify({ adjudicationTtlMs: 1000 }) }));
      expect(response.status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends to the adjudication window on the first read, and re-arms the alarm', async () => {
    const { state, alarms } = fakeState();
    const cache = new EvidenceCache(state);
    vi.useFakeTimers();
    try {
      await cache.fetch(new Request('http://x/store', { method: 'POST', body: JSON.stringify({ envelope: envelope(), ttlMs: 1000 }) }));
      const armedForFiling = alarms.alarm;

      await cache.fetch(new Request('http://x/read', { method: 'POST', body: JSON.stringify({ adjudicationTtlMs: 5000 }) }));
      expect(alarms.alarm).toBeGreaterThan(/** @type {number} */ (armedForFiling));

      // Past the filing expiry, inside the adjudication runway: a second
      // validator re-reading the same envelope still gets it.
      vi.advanceTimersByTime(1500);
      const again = await cache.fetch(new Request('http://x/read', { method: 'POST', body: JSON.stringify({ adjudicationTtlMs: 5000 }) }));
      expect(again.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the filing deadline when an early read has a shorter runway', async () => {
    const { state, alarms } = fakeState();
    const cache = new EvidenceCache(state);
    vi.useFakeTimers();
    try {
      await cache.fetch(new Request('http://x/store', { method: 'POST', body: JSON.stringify({ envelope: envelope(), ttlMs: 5000 }) }));
      const filingDeadline = alarms.alarm;
      await cache.fetch(new Request('http://x/read', { method: 'POST', body: JSON.stringify({ adjudicationTtlMs: 1000 }) }));
      expect(alarms.alarm).toBe(filingDeadline);
      vi.advanceTimersByTime(1500);
      expect((await cache.fetch(new Request('http://x/read', { method: 'POST', body: JSON.stringify({ adjudicationTtlMs: 1000 }) }))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('empties itself when the alarm fires', async () => {
    const { state, values } = fakeState();
    const cache = new EvidenceCache(state);
    await cache.fetch(new Request('http://x/store', { method: 'POST', body: JSON.stringify({ envelope: envelope(), ttlMs: 1000 }) }));
    await cache.alarm();
    expect(values.size).toBe(0);
  });

  it('refuses anything but POST on its internal routes', async () => {
    const { state } = fakeState();
    const cache = new EvidenceCache(state);
    expect((await cache.fetch(new Request('http://x/read'))).status).toBe(405);
  });
});

describe('the Durable-Object-backed store', () => {
  it('implements the same shape the in-memory one does', async () => {
    const { namespace } = fakeNamespace();
    const store = createDurableObjectEvidenceStore(namespace);

    expect(await store.read(REQUEST_ID, 60_000)).toBeNull();
    await store.store(REQUEST_ID, envelope(), 60_000);
    expect(await store.read(REQUEST_ID, 60_000)).toEqual(envelope());
  });

  // One object per request id, addressed by name: the call that writes the
  // evidence is never the call that reads it, and on Workers they are not
  // guaranteed to share an isolate.
  it('keeps each request id in its own object', async () => {
    const { namespace, instances } = fakeNamespace();
    const store = createDurableObjectEvidenceStore(namespace);
    await store.store(REQUEST_ID, envelope(), 60_000);
    await store.store(`0x${'cd'.repeat(32)}`, { ...envelope(), requestId: `0x${'cd'.repeat(32)}` }, 60_000);

    expect(instances.size).toBe(2);
    expect(await store.read(REQUEST_ID, 60_000)).toEqual(envelope());
  });
});
