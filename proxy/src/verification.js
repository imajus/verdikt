// Talking to the confidential workflow (Specification.md §2, Tasks.md 4.3).
//
// WHY THIS IS TRIGGER-THEN-POLL AND NOT ONE REQUEST
//
// Chainlink's docs contradict each other on whether a workflow's return value
// comes back on the HTTP response to the trigger. Spike B settled it by
// observation (docs/spikes/cre.md, CRE-3): it does not — the trigger is
// acknowledged immediately with an empty body, and the handler's result shows
// up separately.
//
// The alternative was to have the proxy make the paid call itself and let the
// enclave verify afterwards. That is rejected: it moves the reading of the
// provider's response out of the enclave, and "the code that reads your data is
// attested" is the entire argument §2 is built on. It is also not actually
// available — an x402 payment settles once, so the enclave's call *is* the
// call, and its response is the only copy of what the agent bought.
//
// So the payload comes back through the workflow's return value, and the proxy
// waits for it.

/** @type {Readonly<Record<string, VerificationFailure>>} */
export const VERIFICATION_FAILURE = Object.freeze({
  /** The workflow never reported a result in time. The agent has paid — never swallow this. */
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
 * A client the proxy can use, and tests can replace.
 *
 * Kept an interface rather than a direct call so the proxy's failure handling —
 * which is the delicate part, because the agent has already paid — is testable
 * without a CRE account, a deployed workflow, or a gateway.
 *
 * @param {WorkflowClientOptions} options
 * @returns {WorkflowClient}
 */
export function createWorkflowClient(options) {
  const doFetch = options.fetch ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 45_000;

  return {
    async verify(request) {
      let executionId;
      try {
        const response = await doFetch(options.triggerUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // The gateway validates a JWT signed by a key in the workflow's
            // `authorizedKeys` (Spike B, CRE-4). That signature — not the
            // on-chain role — is what stops a third party manufacturing a
            // verdict by calling the workflow directly.
            ...(options.authToken ? { authorization: `Bearer ${options.authToken}` } : {})
          },
          body: JSON.stringify({ input: request }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          throw new VerificationError(
            VERIFICATION_FAILURE.TRIGGER_REJECTED,
            `workflow trigger returned ${response.status}`
          );
        }
        const body = await response.json().catch(() => ({}));
        executionId = body?.result?.workflow_execution_id ?? body?.workflow_execution_id;
      } catch (error) {
        if (error instanceof VerificationError) throw error;
        throw new VerificationError(
          VERIFICATION_FAILURE.TRIGGER_REJECTED,
          `could not reach the workflow gateway: ${/** @type {Error} */ (error).message}`
        );
      }

      if (!executionId) {
        throw new VerificationError(
          VERIFICATION_FAILURE.TRIGGER_REJECTED,
          'the gateway accepted the trigger but named no execution to wait on'
        );
      }
      return pollForResult(executionId);
    }
  };

  /** @param {string} executionId */
  async function pollForResult(executionId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await doFetch(`${options.statusUrl}/${executionId}`, {
        headers: options.authToken ? { authorization: `Bearer ${options.authToken}` } : {},
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

      if (status?.status === 'COMPLETED') return parseWorkflowResult(status.result);
      if (status?.status === 'ERRORED' || status?.status === 'FAILED') {
        throw new VerificationError(VERIFICATION_FAILURE.RUN_FAILED, status.error ?? 'the workflow run failed');
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    // Surfaced as a distinct error, never swallowed: the agent paid, and a
    // silent failure here is indistinguishable from a service that took the
    // money and returned nothing.
    throw new VerificationError(
      VERIFICATION_FAILURE.TIMEOUT,
      `the workflow did not report a result within ${timeoutMs}ms`
    );
  }
}

/**
 * The workflow returns a JSON string. Parsed here so the proxy's route handler
 * never touches the wire format.
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
