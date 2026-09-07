// PendingVerification and its client-side adapter, tested as plain classes —
// no Workers runtime needed, same as the rest of this package: neither one
// touches anything beyond Request/Response/setTimeout, which Node already has.
//
// The fake namespace below wires the client straight to real
// PendingVerification instances in-process, so these tests exercise the exact
// register→settle/cancel/timeout races the Durable Object is meant to
// resolve, without Miniflare.

import { describe, expect, it } from 'vitest';
import { VERIFICATION_FAILURE, VerificationError } from './verification.js';
import { PendingVerification, createDurableObjectPendingRegistry } from './pending-do.js';

/** @returns {DurableObjectNamespace} */
function fakeNamespace() {
  /** @type {Map<string, PendingVerification>} */
  const instances = new Map();
  return {
    idFromName: (name) => name,
    get: (id) => {
      if (!instances.has(/** @type {string} */ (id))) instances.set(/** @type {string} */ (id), new PendingVerification());
      const instance = /** @type {PendingVerification} */ (instances.get(/** @type {string} */ (id)));
      return {
        fetch: (url, init) => instance.fetch(new Request(url, init))
      };
    }
  };
}

const REQUEST_ID = `0x${'ab'.repeat(32)}`;

/** @returns {VerificationResult} */
const result = () => ({
  outcome: 'PASS',
  mode: 'sla',
  reason: null,
  clauses: [],
  tx: `0x${'cd'.repeat(32)}`,
  status: 200,
  headers: {},
  body: '{"ok":true}'
});

describe('PendingVerification', () => {
  it('hands a settled result to the waiter', async () => {
    const object = new PendingVerification();
    const waiting = object.fetch(new Request('http://do/wait', { method: 'POST', body: JSON.stringify({ timeoutMs: 5_000 }) }));
    const settled = await object.fetch(new Request('http://do/settle', { method: 'POST', body: JSON.stringify({ result: result() }) }));
    expect((await settled.json()).delivered).toBe(true);

    const response = await waiting;
    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({ outcome: 'PASS' });
  });

  it('refuses a settle for a requestId nobody ever waited on', async () => {
    // Otherwise a forged or stale requestId would be accepted just because it
    // happens to be the first call a freshly created object has seen — the
    // same check the in-memory registry makes via `pending.get(requestId)`.
    const object = new PendingVerification();
    const response = await object.fetch(new Request('http://do/settle', { method: 'POST', body: JSON.stringify({ result: result() }) }));
    expect(response.status).toBe(409);
    expect((await response.json()).delivered).toBe(false);
  });

  it('rejects a settle once already answered', async () => {
    const object = new PendingVerification();
    const waiting = object.fetch(new Request('http://do/wait', { method: 'POST', body: JSON.stringify({ timeoutMs: 5_000 }) }));
    await object.fetch(new Request('http://do/settle', { method: 'POST', body: JSON.stringify({ result: result() }) }));
    const second = await object.fetch(new Request('http://do/settle', { method: 'POST', body: JSON.stringify({ result: result() }) }));
    expect(second.status).toBe(409);
    expect((await second.json()).delivered).toBe(false);
    await waiting;
  });

  it('times out rather than waiting forever', async () => {
    const object = new PendingVerification();
    const response = await object.fetch(new Request('http://do/wait', { method: 'POST', body: JSON.stringify({ timeoutMs: 5 }) }));
    expect(response.status).toBe(504);
    expect((await response.json()).error).toBe(VERIFICATION_FAILURE.TIMEOUT);
  });

  it('rejects the waiter on cancel, carrying the failure and message', async () => {
    const object = new PendingVerification();
    const waiting = object.fetch(new Request('http://do/wait', { method: 'POST', body: JSON.stringify({ timeoutMs: 5_000 }) }));
    await object.fetch(
      new Request('http://do/cancel', {
        method: 'POST',
        body: JSON.stringify({ failure: VERIFICATION_FAILURE.TRIGGER_REJECTED, message: 'gateway refused' })
      })
    );
    const response = await waiting;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: VERIFICATION_FAILURE.TRIGGER_REJECTED, message: 'gateway refused' });
  });
});

describe('createDurableObjectPendingRegistry', () => {
  it('resolves await() with the settled result', async () => {
    const pending = createDurableObjectPendingRegistry(fakeNamespace());
    const waiting = pending.await(REQUEST_ID, 5_000);
    expect(await pending.settle(REQUEST_ID, result())).toBe(true);
    await expect(waiting).resolves.toMatchObject({ outcome: 'PASS' });
  });

  it('rejects await() as a VerificationError on cancel', async () => {
    const pending = createDurableObjectPendingRegistry(fakeNamespace());
    const waiting = pending.await(REQUEST_ID, 5_000);
    await pending.cancel(REQUEST_ID, new VerificationError(VERIFICATION_FAILURE.TRIGGER_REJECTED, 'refused'));
    await expect(waiting).rejects.toMatchObject({ failure: VERIFICATION_FAILURE.TRIGGER_REJECTED, message: 'refused' });
  });

  it('rejects await() with TIMEOUT when nothing ever settles', async () => {
    const pending = createDurableObjectPendingRegistry(fakeNamespace());
    await expect(pending.await(REQUEST_ID, 5)).rejects.toMatchObject({ failure: VERIFICATION_FAILURE.TIMEOUT });
  });

  it('reports false for a requestId nobody awaited', async () => {
    const pending = createDurableObjectPendingRegistry(fakeNamespace());
    expect(await pending.settle(REQUEST_ID, result())).toBe(false);
    expect(await pending.cancel(REQUEST_ID, new Error('x'))).toBe(false);
  });

  it('reports whether a settle or cancel found the waiter still there', async () => {
    const pending = createDurableObjectPendingRegistry(fakeNamespace());
    const waiting = pending.await(REQUEST_ID, 5_000);
    expect(await pending.settle(REQUEST_ID, result())).toBe(true);
    expect(await pending.settle(REQUEST_ID, result())).toBe(false);
    await waiting;
  });

  it('routes two different requestIds to two different objects', async () => {
    const namespace = fakeNamespace();
    const pending = createDurableObjectPendingRegistry(namespace);
    const idA = `0x${'aa'.repeat(32)}`;
    const idB = `0x${'bb'.repeat(32)}`;
    const waitingA = pending.await(idA, 5_000);
    const waitingB = pending.await(idB, 5_000);

    await pending.settle(idB, { ...result(), body: 'B' });
    await pending.settle(idA, { ...result(), body: 'A' });

    await expect(waitingA).resolves.toMatchObject({ body: 'A' });
    await expect(waitingB).resolves.toMatchObject({ body: 'B' });
  });
});
