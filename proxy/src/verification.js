// Talking to the confidential workflow (Specification.md §2, Tasks.md 4.3).
//
// WHY THIS IS TRIGGER-THEN-WAIT-FOR-A-CALLBACK
//
// Two findings shape it, both in docs/spikes/cre.md:
//
//   CRE-3 — the trigger response does not carry the handler's return value. It
//   answers `{ status: "ACCEPTED", workflow_execution_id }` immediately.
//
//   CRE-9 — and there is no documented HTTP endpoint for reading that
//   execution's result. The CRE UI and `cre execution status` are the only
//   documented readers, neither of which a proxy can call per request.
//
// So polling is not available, and the proxy still has to return the payload:
// an x402 payment settles once, which makes the enclave's call THE call and its
// response the only copy of what the agent bought.
//
// The workflow therefore pushes its result back, from inside the enclave, to a
// callback this proxy serves. The agent's connection is already being held
// open; `requestId` correlates the two. The alternative — the proxy making the
// paid call and the enclave verifying afterwards — was rejected because it
// moves the reading of the provider's response out of the enclave, which is the
// argument §2 is built on.

import { mintTriggerJwt } from './jwt.js';

/** @type {Readonly<Record<string, VerificationFailure>>} */
export const VERIFICATION_FAILURE = Object.freeze({
  /** No callback arrived in time. The agent has paid — never swallow this. */
  TIMEOUT: 'workflow_timeout',
  /** The gateway refused the trigger, so no verification happened at all. */
  TRIGGER_REJECTED: 'trigger_rejected',
  /** The run reported an error rather than a verdict. */
  RUN_FAILED: 'run_failed'
});

export class VerificationError extends Error {
  /**
   * @param {VerificationFailure} failure
   * @param {string} message
   */
  constructor(failure, message) {
    super(message);
    this.name = 'VerificationError';
    this.failure = failure;
  }
}

/**
 * Requests waiting on a callback, keyed by `requestId`.
 *
 * In-memory on purpose: an entry is only meaningful while this process is
 * holding the agent's connection, so persisting it would outlive the thing it
 * refers to. One consequence to state rather than discover — a proxy restart
 * loses in-flight calls, and horizontal scaling needs the callback to reach the
 * same instance.
 */
export function createPendingRegistry() {
  /** @type {Map<string, { resolve: (result: VerificationResult) => void, reject: (error: Error) => void }>} */
  const pending = new Map();

  return {
    get size() {
      return pending.size;
    },

    /**
     * @param {string} requestId
     * @param {number} timeoutMs
     * @returns {Promise<VerificationResult>}
     */
    await(requestId, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(
            new VerificationError(
              VERIFICATION_FAILURE.TIMEOUT,
              `no callback for ${requestId} within ${timeoutMs}ms`
            )
          );
        }, timeoutMs);
        // `unref` so a pending verification cannot hold the process open.
        timer.unref?.();
        pending.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pending.delete(requestId);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            pending.delete(requestId);
            reject(error);
          }
        });
      });
    },

    /**
     * Hand a callback's payload to whoever is waiting.
     *
     * Returns false for an unknown `requestId` — already answered, timed out,
     * or never issued by this process — so the route can reject it rather than
     * accept a result nobody asked for.
     *
     * @param {string} requestId
     * @param {VerificationResult} result
     */
    settle(requestId, result) {
      const waiter = pending.get(requestId);
      if (!waiter) return false;
      waiter.resolve(result);
      return true;
    },

    /**
     * Fail a waiter that will never be answered — the trigger was refused, so
     * no callback is coming. Without this the agent waits out the full timeout
     * for an error already known.
     *
     * @param {string} requestId
     * @param {Error} error
     */
    cancel(requestId, error) {
      const waiter = pending.get(requestId);
      if (!waiter) return false;
      waiter.reject(error);
      return true;
    }
  };
}

/**
 * @param {WorkflowClientOptions} options
 * @returns {WorkflowClient}
 */
export function createWorkflowClient(options) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const pending = options.pending ?? createPendingRegistry();

  return {
    pending,

    async verify(request) {
      // Registered BEFORE the trigger is sent: the enclave can call back faster
      // than the trigger response returns, and a callback arriving first would
      // otherwise find nothing waiting and be rejected.
      const waiting = pending.await(request.requestId, timeoutMs);

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: request.requestId,
        method: 'workflows.execute',
        params: {
          input: { ...request, callbackUrl: options.callbackUrl },
          workflow: { workflowID: options.workflowId }
        }
      });

      try {
        // The JWT digests this exact string, so the same one must be sent —
        // re-serialising would change the bytes and fail authorisation.
        const authorization = await mintTriggerJwt({ body, privateKey: options.privateKey });
        const response = await doFetch(options.triggerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${authorization}` },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          throw new VerificationError(
            VERIFICATION_FAILURE.TRIGGER_REJECTED,
            `workflow trigger returned ${response.status}`
          );
        }
        const answer = await response.json().catch(() => ({}));
        if (answer?.error) {
          throw new VerificationError(
            VERIFICATION_FAILURE.TRIGGER_REJECTED,
            `gateway refused the trigger: ${answer.error?.message ?? JSON.stringify(answer.error)}`
          );
        }
        if (answer?.result?.status && answer.result.status !== 'ACCEPTED') {
          throw new VerificationError(
            VERIFICATION_FAILURE.TRIGGER_REJECTED,
            `gateway answered ${answer.result.status}`
          );
        }
      } catch (error) {
        const failure =
          error instanceof VerificationError
            ? error
            : new VerificationError(
                VERIFICATION_FAILURE.TRIGGER_REJECTED,
                `could not reach the workflow gateway: ${/** @type {Error} */ (error).message}`
              );
        // Release the waiter registered above, or it sits until the timeout for
        // an error already known. Swallow its rejection — `failure` is thrown.
        waiting.catch(() => {});
        pending.cancel(request.requestId, failure);
        throw failure;
      }

      return waiting;
    }
  };
}

/**
 * Normalise what the workflow sent back.
 *
 * @param {unknown} raw
 * @returns {VerificationResult}
 */
export function parseWorkflowResult(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed === null || typeof parsed !== 'object') {
    throw new VerificationError(VERIFICATION_FAILURE.RUN_FAILED, 'the workflow returned no result');
  }
  const result = /** @type {Record<string, unknown>} */ (parsed);
  return {
    outcome: /** @type {SlaOutcome|null} */ (result.outcome ?? null),
    mode: /** @type {JudgementMode} */ (result.mode),
    reason: /** @type {string|null} */ (result.reason ?? null),
    clauses: /** @type {SlaClauseResult[]} */ (result.clauses ?? []),
    tx: /** @type {string|null} */ (result.tx ?? null),
    status: typeof result.status === 'number' ? result.status : null,
    headers: /** @type {Record<string,string>} */ (result.headers ?? {}),
    body: typeof result.body === 'string' ? result.body : '',
    bodyTruncated: result.bodyTruncated === true
  };
}
