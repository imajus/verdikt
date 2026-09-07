import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createWorkflowClient } from './verification.js';

const config = loadConfig();

// Built here, not inside buildApp, so tests can hand in their own client and
// never reach a gateway. A missing config means the proxy still serves the
// unpaid leg and refuses paid calls, rather than failing to start — the payTo
// check is useful on its own.
const workflow = config.workflow ? createWorkflowClient(config.workflow) : null;
if (!workflow) {
  // Not fatal: the unpaid leg's payTo check is useful on its own, and refusing
  // paid calls beats relaying one nothing judged.
  console.warn('[verdikt] no CRE trigger configured — paid calls will be refused');
} else if (!config.callbackToken) {
  // The enclave pushes its result to a callback; with no shared secret the
  // route refuses every one, so every paid call would time out.
  console.warn('[verdikt] CRE_CALLBACK_TOKEN unset — callbacks will be refused and paid calls will time out');
}

// `marketplace` is deliberately not wired here. The discovery API needs a
// service's SLA clauses to filter on price and latency, and the only correct
// reader of an SLA document is @verdikt/sla — which CLAUDE.md forbids the proxy
// from depending on, transitively included. Wiring it needs a decision, not a
// workaround; see docs/Tasks.md 5.3. Until then /services answers 503 and says
// why, which is better than a marketplace that looks empty.
const app = buildApp({ config, workflow, logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.listen({ port: config.port, host: config.host });
