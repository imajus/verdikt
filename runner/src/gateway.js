// Thin authenticated forwarder: verifies the proxy's trigger JWT, unwraps the
// JSON-RPC `workflows.execute` envelope (proxy/src/verification.js), and
// relays `params.input` to a `cre workflow simulate --listen` process's
// `POST /trigger` endpoint (cre/workflows/README.md). This is the whole job —
// the workflow itself owns the return leg, POSTing its verdict straight to
// `input.callbackUrl` once it finishes (cre/workflows/verify/workflow.ts,
// ~line 245), so this file never reads or judges a response body.
//
// Caveat baked into the design here (see README.md "Known unknowns"): it is
// not documented whether `POST /trigger` on the simulator blocks until the
// workflow finishes, or returns as soon as the run is accepted. This code
// does not assume either — it races the forward against `ackTimeoutMs` and
// treats "still running past the timeout" the same as "accepted", because
// either way the workflow's own callback is what actually resolves the
// proxy's wait. It only reports failure when the simulator refuses the
// connection outright (process not up, wrong port, etc).

import { verifyTriggerJwt, TriggerJwtError } from './jwt.js';

const JSONRPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Reserved for application errors in the -32000..-32099 band, matching how
  // the proxy already tolerates `answer.error` shaped this way.
  UNAUTHORIZED: -32001,
  UPSTREAM_UNAVAILABLE: -32002
});

/** @param {unknown} id @param {number} code @param {string} message */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** @param {unknown} id @param {string} workflowExecutionId */
function rpcAccepted(id, workflowExecutionId) {
  return { jsonrpc: '2.0', id, result: { status: 'ACCEPTED', workflow_execution_id: workflowExecutionId } };
}

/**
 * @param {{
 *   authorization: string|null,
 *   rawBody: string,
 *   config: Pick<
 *     ReturnType<typeof import('./config.js').loadConfig>,
 *     'triggerAddress' | 'jwtMaxAgeSeconds' | 'simulatorUrl' | 'triggerAckTimeoutMs' | 'expectedWorkflowId'
 *   >,
 *   fetchImpl?: typeof fetch,
 *   now?: number
 * }} options
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function handleTrigger({ authorization, rawBody, config, fetchImpl = fetch, now }) {
  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(null, JSONRPC_ERROR.PARSE_ERROR, 'invalid JSON body') };
  }

  const { id, method, params } = envelope ?? {};
  if (envelope?.jsonrpc !== '2.0' || typeof method !== 'string') {
    return { status: 400, body: rpcError(id ?? null, JSONRPC_ERROR.INVALID_REQUEST, 'not a JSON-RPC 2.0 request') };
  }

  try {
    await verifyTriggerJwt({
      authorization,
      body: rawBody,
      expectedSignerAddress: config.triggerAddress,
      maxAgeSeconds: config.jwtMaxAgeSeconds,
      now
    });
  } catch (error) {
    const failure = error instanceof TriggerJwtError ? error.failure : 'verification_failed';
    return { status: 401, body: rpcError(id, JSONRPC_ERROR.UNAUTHORIZED, `unauthorized: ${failure}`) };
  }

  if (method !== 'workflows.execute') {
    return { status: 404, body: rpcError(id, JSONRPC_ERROR.METHOD_NOT_FOUND, `unsupported method ${method}`) };
  }

  const input = params?.input;
  const workflowID = params?.workflow?.workflowID;
  if (input === null || typeof input !== 'object') {
    return { status: 400, body: rpcError(id, JSONRPC_ERROR.INVALID_PARAMS, 'params.input is required') };
  }
  if (config.expectedWorkflowId && workflowID !== config.expectedWorkflowId) {
    return {
      status: 400,
      body: rpcError(
        id,
        JSONRPC_ERROR.INVALID_PARAMS,
        `params.workflow.workflowID ${workflowID} does not match the workflow this host is running (${config.expectedWorkflowId})`
      )
    };
  }

  try {
    await fetchImpl(config.simulatorUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(config.triggerAckTimeoutMs)
    });
    // Whether this resolved because the simulator answered, or because the
    // timeout raced it, treated identically — see the file-header caveat.
  } catch (error) {
    if (/** @type {Error} */ (error).name === 'TimeoutError') {
      // The forward went out; the simulator just hasn't answered within the
      // ack window. Not a failure — accept it and let the workflow's own
      // callback be the real signal, same as the "still running" case.
    } else {
      return {
        status: 502,
        body: rpcError(
          id,
          JSONRPC_ERROR.UPSTREAM_UNAVAILABLE,
          `could not reach the simulator at ${config.simulatorUrl}: ${/** @type {Error} */ (error).message}`
        )
      };
    }
  }

  // No real CRE execution id exists here (simulate mode has none to hand
  // back) — the requestId doubles as an opaque token. The proxy only checks
  // `result.status === 'ACCEPTED'` (proxy/src/verification.js) and never
  // reads this field, so a synthetic value is sufficient.
  return { status: 200, body: rpcAccepted(id, `sim-${input.requestId ?? id}`) };
}
