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
    parentName: env.ENS_PARENT_NAME,
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
    arc: {
      rpcUrl: env.ARC_RPC_URL,
      address: env.VERDIKT_REGISTRY_ADDRESS,
      deployBlock: env.VERDIKT_REGISTRY_DEPLOY_BLOCK ? BigInt(env.VERDIKT_REGISTRY_DEPLOY_BLOCK) : undefined
    }
  };
}
