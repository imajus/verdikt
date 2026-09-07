// The Durable Object counterpart to `createPendingRegistry()` in
// verification.js.
//
// That in-memory registry works because a Node process is one long-lived
// thing: the request holding the agent's connection and the callback that
// answers it run in the same process, so a plain Map bridges them. A Workers
// isolate is not that — two HTTP requests to the same Worker are not
// guaranteed to land on the same isolate, so nothing in module scope can
// bridge a trigger and its callback.
//
// A Durable Object is Cloudflare's primitive for exactly this: one object,
// addressed by name, that every request for that name reaches regardless of
// which isolate handled it. One object per requestId, so the trigger's
// `/wait` and the callback's `/settle` always meet.
//
// No `state.storage` is used. An object is meaningful only for the lifetime
// of one verification; persisting it would outlive the thing it refers to,
// same as the in-memory registry's own doc comment says.

import { VERIFICATION_FAILURE, VerificationError } from './verification.js';

/**
 * @typedef {{ kind: 'result', result: VerificationResult }
 *   | { kind: 'error', failure: VerificationFailure, message: string }
 *   | { kind: 'timeout' }} Outcome
 */

export class PendingVerification {
  constructor() {
    // Distinct from `outcome`: this is "has anyone ever called /wait on this
    // object", checked by settle/cancel so a requestId nobody issued — forged,
    // or from a different proxy instance — cannot be accepted just because it
    // happens to be the first call this (freshly created) object has seen.
    this.registered = false;
    /** @type {Outcome | null} */
    this.outcome = null;
    /** @type {((response: Response) => void) | null} */
    this.notify = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
  }

  /** @param {Request} request */
  async fetch(request) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const { pathname } = new URL(request.url);
    if (pathname === '/wait') {
      // Set before the body is even parsed, so it is true the instant this
      // object starts handling the request — the same instant a settle/cancel
      // for the same requestId could first possibly arrive.
      this.registered = true;
      const { timeoutMs } = /** @type {{ timeoutMs: number }} */ (await request.json());
      return this.#wait(timeoutMs);
    }
    if (pathname === '/settle') {
      const { result } = /** @type {{ result: VerificationResult }} */ (await request.json());
      return this.#finish({ kind: 'result', result });
    }
    if (pathname === '/cancel') {
      const { failure, message } = /** @type {{ failure: VerificationFailure, message: string }} */ (
        await request.json()
      );
      return this.#finish({ kind: 'error', failure, message });
    }
    return new Response('not found', { status: 404 });
  }

  /**
   * Registration and consumption are one call, not two, because both happen
   * in the same tick as the caller dispatches the trigger request: `fetch()`
   * begins the request the instant it is called, before anyone awaits it, so
   * this object starts listening before the caller ever sends the trigger —
   * the same guarantee the in-memory registry gets from `Map.set` being
   * synchronous, just carried by network ordering (Worker→Object is on
   * Cloudflare's own network, and is orders of magnitude faster than the
   * external gateway round trip plus the workflow's own execution) instead of
   * by zero latency.
   *
   * @param {number} timeoutMs
   */
  #wait(timeoutMs) {
    if (this.outcome) return this.#respond(this.outcome);
    return new Promise((resolve) => {
      this.notify = resolve;
      this.timer = setTimeout(() => this.#finish({ kind: 'timeout' }), timeoutMs);
      // Not every runtime's setTimeout returns something unref-able — this
      // object outlives nothing else in the isolate that unref would matter to.
      /** @type {any} */ (this.timer)?.unref?.();
    });
  }

  /** @param {Outcome} outcome */
  #finish(outcome) {
    // Already answered, timed out, or never issued — same "was anyone
    // actually waiting" question the in-memory registry's settle()/cancel()
    // answer, just phrased as a response rather than a boolean.
    if (!this.registered || this.outcome) return Response.json({ delivered: false }, { status: 409 });
    this.outcome = outcome;
    if (this.timer) clearTimeout(this.timer);
    if (this.notify) {
      const notify = this.notify;
      this.notify = null;
      notify(this.#respond(outcome));
    }
    return Response.json({ delivered: true });
  }

  /** @param {Outcome} outcome */
  #respond(outcome) {
    if (outcome.kind === 'result') return Response.json({ result: outcome.result });
    if (outcome.kind === 'timeout') {
      return Response.json({ error: VERIFICATION_FAILURE.TIMEOUT, message: 'timed out waiting for a callback' }, { status: 504 });
    }
    return Response.json({ error: outcome.failure, message: outcome.message }, { status: 502 });
  }
}

/**
 * The client side: the same `PendingRegistry` shape `verification.js` already
 * takes as `options.pending`, backed by one Durable Object per requestId
 * instead of a Map. `createWorkflowClient` does not know the difference.
 *
 * @param {DurableObjectNamespace} namespace
 * @returns {PendingRegistry}
 */
export function createDurableObjectPendingRegistry(namespace) {
  const stubFor = (/** @type {string} */ requestId) => namespace.get(namespace.idFromName(requestId));

  return {
    // Not tracked: each requestId is its own object, so there is no
    // process-wide count to report. Only the in-memory registry's own tests
    // read `.size` — nothing in the request path does.
    get size() {
      return NaN;
    },

    async await(requestId, timeoutMs) {
      const response = await stubFor(requestId).fetch('http://pending-verification/wait', {
        method: 'POST',
        body: JSON.stringify({ timeoutMs })
      });
      const payload = /** @type {{ result?: VerificationResult, error?: string, message?: string }} */ (
        await response.json()
      );
      if (!response.ok) {
        throw new VerificationError(
          /** @type {VerificationFailure} */ (payload.error ?? VERIFICATION_FAILURE.RUN_FAILED),
          payload.message ?? `no callback for ${requestId} within ${timeoutMs}ms`
        );
      }
      return /** @type {VerificationResult} */ (payload.result);
    },

    async settle(requestId, result) {
      const response = await stubFor(requestId).fetch('http://pending-verification/settle', {
        method: 'POST',
        body: JSON.stringify({ result })
      });
      return (/** @type {{ delivered: boolean }} */ (await response.json())).delivered === true;
    },

    async cancel(requestId, error) {
      const response = await stubFor(requestId).fetch('http://pending-verification/cancel', {
        method: 'POST',
        body: JSON.stringify({
          failure: /** @type {VerificationError} */ (error).failure ?? VERIFICATION_FAILURE.RUN_FAILED,
          message: error.message
        })
      });
      return (/** @type {{ delivered: boolean }} */ (await response.json())).delivered === true;
    }
  };
}
