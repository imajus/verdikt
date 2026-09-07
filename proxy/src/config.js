// Proxy configuration, read once at startup.

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {ProxyConfig}
 */
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PROXY_PORT ?? 8402),
    host: env.PROXY_HOST ?? '0.0.0.0',
    /**
     * Agents call `<slug>.verdikt.bond/<path>`, so the slug arrives in the Host
     * header in production. The `/:slug/*` path form stays supported for local
     * development and for tests, which have no wildcard DNS.
     */
    publicHost: env.PROXY_PUBLIC_HOST ?? 'verdikt.bond',
    /**
     * The unpaid leg resolves the same subname on every request. A short TTL
     * keeps a provider's `payTo` change visible quickly while not putting a
     * Sepolia round trip in front of every 402.
     */
    ensCacheTtlMs: Number(env.PROXY_ENS_CACHE_TTL_MS ?? 30_000),
    upstreamTimeoutMs: Number(env.PROXY_UPSTREAM_TIMEOUT_MS ?? 30_000),
    /**
     * Providers choose their own upstream URL, and the proxy makes the request
     * from Verdikt's network. Without this the `url` record is a
     * server-side-request-forgery primitive pointed at whatever the proxy can
     * reach. Only turn it on for a demo provider on localhost.
     */
    allowPrivateUpstream: env.PROXY_ALLOW_PRIVATE_UPSTREAM === 'true',
    /**
     * The shared secret the enclave presents on the callback. Without it the
     * callback route refuses everything, which is the safe direction: a paid
     * call then times out rather than being answered by anyone who can reach
     * the port.
     */
    callbackToken: env.CRE_CALLBACK_TOKEN,
    /**
     * Unset means the proxy refuses paid calls outright. Relaying one
     * unverified would take an agent's money for a call nothing judged.
     *
     * There is no status URL: no HTTP endpoint for reading an execution's
     * result is documented (docs/spikes/cre.md, CRE-9), so the workflow pushes
     * its result to `callbackUrl` instead.
     */
    workflow:
      env.CRE_TRIGGER_URL && env.CRE_WORKFLOW_ID && env.CRE_TRIGGER_PRIVATE_KEY && env.CRE_CALLBACK_URL
        ? {
            triggerUrl: env.CRE_TRIGGER_URL,
            workflowId: env.CRE_WORKFLOW_ID,
            privateKey: env.CRE_TRIGGER_PRIVATE_KEY,
            callbackUrl: env.CRE_CALLBACK_URL,
            timeoutMs: Number(env.PROXY_VERIFY_TIMEOUT_MS ?? 45_000)
          }
        : null,
    arc: {
      rpcUrl: env.ARC_RPC_URL,
      address: env.VERDIKT_REGISTRY_ADDRESS,
      deployBlock: env.VERDIKT_REGISTRY_DEPLOY_BLOCK ? BigInt(env.VERDIKT_REGISTRY_DEPLOY_BLOCK) : undefined
    }
  };
}
