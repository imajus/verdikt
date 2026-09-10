// Env loader, same shape as proxy/src/config.js's loadConfig(): a plain
// function over a source object (defaults to process.env) so tests can pass
// a fixture instead of touching real env vars.

/** @param {Record<string,string|undefined>} source @param {string} name */
function env(source, name) {
  const value = source[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * @param {Record<string,string|undefined>} [source]
 * @returns {{
 *   port: number,
 *   triggerAddress: string,
 *   jwtMaxAgeSeconds: number,
 *   simulatorUrl: string,
 *   triggerAckTimeoutMs: number,
 *   workflowDir: string,
 *   workflowTarget: string,
 *   workflowName: string,
 *   broadcast: boolean,
 *   simulatorWarmupMs: number,
 *   expectedWorkflowId: string|undefined
 * }}
 */
export function loadConfig(source = process.env) {
  const triggerAddress = env(source, 'RUNNER_TRIGGER_ADDRESS');
  if (!triggerAddress) {
    // Mirrors the proxy's workflowConfig() stance (proxy/src/config.js): fail
    // loudly at startup rather than silently accepting unauthenticated
    // triggers once a request actually arrives.
    throw new Error('RUNNER_TRIGGER_ADDRESS is required: the address expected to sign the proxy\'s trigger JWTs');
  }

  return {
    port: Number(env(source, 'RUNNER_PORT') ?? 8787),
    triggerAddress,
    jwtMaxAgeSeconds: Number(env(source, 'RUNNER_JWT_MAX_AGE_SECONDS') ?? 300),
    simulatorUrl: env(source, 'RUNNER_SIMULATOR_URL') ?? 'http://127.0.0.1:2000/trigger',
    triggerAckTimeoutMs: Number(env(source, 'RUNNER_TRIGGER_ACK_TIMEOUT_MS') ?? 5000),
    workflowDir: env(source, 'RUNNER_WORKFLOW_DIR') ?? '/app/cre/workflows',
    workflowTarget: env(source, 'RUNNER_CRE_TARGET') ?? 'staging-settings',
    workflowName: env(source, 'RUNNER_WORKFLOW_NAME') ?? 'verify',
    broadcast: (env(source, 'RUNNER_CRE_BROADCAST') ?? 'false') === 'true',
    simulatorWarmupMs: Number(env(source, 'RUNNER_SIMULATOR_WARMUP_MS') ?? 15000),
    // Optional: if set, gateway.js rejects triggers naming a different
    // workflow ID than the one this host is actually running --listen for.
    expectedWorkflowId: env(source, 'RUNNER_WORKFLOW_ID')
  };
}
