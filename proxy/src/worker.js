// The Cloudflare Worker entry point. `handleRequest` in router.js is the
// framework-agnostic core; everything here is Workers-specific wiring —
// reading `env` instead of `process.env`, and handing the pending-callback
// rendezvous to the Durable Object instead of an in-process Map.

import { createRegistryReader, decodePayment, resolveServiceRecord } from '@verdikt/sdk';
import { loadConfig } from './config.js';
import { handleRequest } from './router.js';
import { createDurableObjectPendingRegistry } from './pending-do.js';
import { createWorkflowClient } from './verification.js';

export { PendingVerification } from './pending-do.js';

/** @type {{ config: ProxyConfig, registry: ReturnType<typeof createRegistryReader>, workflow: WorkflowClient|null } | null} */
let cached = null;

/**
 * Built once per isolate, not per request: `env`'s bindings do not change
 * between requests a running isolate handles, and a fresh registry reader or
 * workflow client per call would mean re-resolving RPC transports on every
 * hit. Memoized here rather than at module scope because `env` is only
 * available once `fetch` is called.
 *
 * @param {WorkerEnv} env
 */
function context(env) {
  if (cached) return cached;
  const config = loadConfig(/** @type {Record<string, string|undefined>} */ (/** @type {unknown} */ (env)));
  const registry = createRegistryReader(config.arc);
  const workflow = config.workflow
    ? createWorkflowClient({ ...config.workflow, pending: createDurableObjectPendingRegistry(env.PENDING_VERIFICATION) })
    : null;
  if (!workflow) {
    // Not fatal: the unpaid leg's payTo check is useful on its own, and
    // refusing paid calls beats relaying one nothing judged.
    console.warn('[verdikt] no CRE trigger configured — paid calls will be refused');
  } else if (!config.callbackToken) {
    // The enclave pushes its result to a callback; with no shared secret the
    // route refuses every one, so every paid call would time out.
    console.warn('[verdikt] CRE_CALLBACK_TOKEN unset — callbacks will be refused and paid calls will time out');
  }
  cached = { config, registry, workflow };
  return cached;
}

export default {
  /**
   * @param {Request} request
   * @param {WorkerEnv} env
   */
  async fetch(request, env) {
    const { config, registry, workflow } = context(env);
    // `marketplace` is deliberately not wired here. The discovery API needs a
    // service's SLA clauses to filter on price and latency, and the only
    // correct reader of an SLA document is @verdikt/sla — which CLAUDE.md
    // forbids the proxy from depending on, transitively included. Wiring it
    // needs a decision, not a workaround; see docs/Tasks.md 5.3. Until then
    // /services answers 503 and says why.
    return handleRequest(request, { config, registry, workflow, resolveServiceRecord, decodePayment, fetch });
  }
};
