import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createWorkflowClient } from './verification.js';

const config = loadConfig();

// Built here, not inside buildApp, so tests can hand in their own client and
// never reach a gateway. A missing config means the proxy still serves the
// unpaid leg and refuses paid calls, rather than failing to start — the payTo
// check is useful on its own.
const workflow = config.workflow ? createWorkflowClient(config.workflow) : null;

const app = buildApp({ config, workflow, logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.listen({ port: config.port, host: config.host });
