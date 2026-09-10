#!/usr/bin/env node
// Entrypoint: wires config + the simulator supervisor + the HTTP gateway
// together. Exposes `GET /healthz` and `POST /workflows/execute` — repoint
// the proxy's `CRE_TRIGGER_URL` (proxy/wrangler.jsonc) at
// `https://<this-host>/workflows/execute` and nothing else in the proxy
// changes. See README.md for the full setup and every caveat.

import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { handleTrigger } from './gateway.js';
import { createSimulatorSupervisor } from './simulator.js';
import { readRequestBody } from './request-body.js';

async function main() {
  const config = loadConfig();
  const simulator = createSimulatorSupervisor({
    workflowDir: config.workflowDir,
    workflowName: config.workflowName,
    target: config.workflowTarget,
    broadcast: config.broadcast,
    warmupMs: config.simulatorWarmupMs,
    onLog: (line, stream) => process[stream === 'stderr' ? 'stderr' : 'stdout'].write(`[simulator] ${line}`)
  });

  console.log(
    `starting cre workflow simulate ${config.workflowName} --listen --target ${config.workflowTarget}` +
      `${config.broadcast ? ' --broadcast' : ''} (cwd ${config.workflowDir})`
  );
  simulator.start();
  await simulator.waitUntilReady();
  console.log('simulator warmup window elapsed (or readiness banner matched) — accepting triggers now');

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, simulatorPid: simulator.pid }));
      return;
    }

    if (req.method === 'POST' && req.url === '/workflows/execute') {
      void (async () => {
        const rawBody = await readRequestBody(req, res, config.maxRequestBodyBytes);
        if (rawBody === null) return;
        try {
          const { status, body } = await handleTrigger({
            authorization: req.headers.authorization ?? null,
            rawBody,
            config
          });
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        } catch (error) {
          console.error('unhandled error in handleTrigger', error);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }));
        }
      })();
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  server.listen(config.port, () => {
    console.log(`runner listening on :${config.port}`);
  });

  const shutdown = () => {
    console.log('shutting down');
    server.close();
    simulator.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('fatal startup error', error);
  process.exit(1);
});
