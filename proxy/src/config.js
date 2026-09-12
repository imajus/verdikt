// Proxy configuration, read once at startup.

/**
 * @param {Record<string, string|undefined>} [source]
 * @returns {ProxyConfig}
 */
export function loadConfig(source = process.env) {
  // An empty value is an absent one. `.env.example` ships bare keys, so a
  // copied file is full of empty strings that `??` would happily accept.
  /** @param {string} name */
  const env = (name) => {
    const value = source[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  /**
   * All four or nothing — a half-configured trigger would refuse paid calls in
   * a way that looks like a bug rather than a decision.
   * @returns {ProxyConfig['workflow']}
   */
  const workflowConfig = () => {
    const triggerUrl = env('CRE_TRIGGER_URL');
    const workflowId = env('CRE_WORKFLOW_ID');
    const privateKey = env('CRE_TRIGGER_PRIVATE_KEY');
    const callbackUrl = env('CRE_CALLBACK_URL');
    if (!triggerUrl || !workflowId || !privateKey || !callbackUrl) return null;
    return { triggerUrl, workflowId, privateKey, callbackUrl, timeoutMs: Number(env('PROXY_VERIFY_TIMEOUT_MS') ?? 45_000) };
  };
  /**
   * `PAYMENT_RPC_URLS` as `<chainId>=<url>` pairs, comma-separated —
   * e.g. `8453=https://mainnet.base.org,137=https://polygon-rpc.com`.
   *
   * A map rather than a single URL because the chain is the *provider's*
   * choice: its 402 names where it wants to be paid, and that is routinely
   * neither of Verdikt's own two chains. Unparseable pairs are dropped rather
   * than thrown on — a typo in one chain must not take the proxy down for the
   * rest, and the consequence is only that contract payers on that chain are
   * refused, which is the safe direction.
   *
   * @returns {Record<number, string>}
   */
  const paymentRpcUrls = () => {
    /** @type {Record<number, string>} */
    const urls = {};
    for (const pair of (env('PAYMENT_RPC_URLS') ?? '').split(',')) {
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const chainId = Number(pair.slice(0, at).trim());
      const url = pair.slice(at + 1).trim();
      if (Number.isInteger(chainId) && chainId > 0 && url !== '') urls[chainId] = url;
    }
    return urls;
  };

  return {
    /**
     * Agents call `<slug>.verdikt.bond/<path>`, so the slug arrives in the Host
     * header in production. The `/:slug/*` path form stays supported for local
     * development and for tests, which have no wildcard DNS.
     */
    publicHost: env('PROXY_PUBLIC_HOST') ?? 'verdikt.bond',
    /**
     * The unpaid leg resolves the same subname on every request. A short TTL
     * keeps a provider's `payTo` change visible quickly while not putting a
     * Sepolia round trip in front of every 402.
     */
    ensCacheTtlMs: Number(env('PROXY_ENS_CACHE_TTL_MS') ?? 30_000),
    upstreamTimeoutMs: Number(env('PROXY_UPSTREAM_TIMEOUT_MS') ?? 30_000),
    /**
     * Providers choose their own upstream URL, and the proxy makes the request
     * from Verdikt's network. Without this the `url` record is a
     * server-side-request-forgery primitive pointed at whatever the proxy can
     * reach. Only turn it on for a demo provider on localhost.
     */
    allowPrivateUpstream: env('PROXY_ALLOW_PRIVATE_UPSTREAM') === 'true',
    /**
     * The shared secret the enclave presents on the callback. Without it the
     * callback route refuses everything, which is the safe direction: a paid
     * call then times out rather than being answered by anyone who can reach
     * the port.
     */
    callbackToken: env('CRE_CALLBACK_TOKEN'),
    /**
     * Unset means the proxy refuses paid calls outright. Relaying one
     * unverified would take an agent's money for a call nothing judged.
     *
     * There is no status URL: no HTTP endpoint for reading an execution's
     * result is documented (docs/spikes/cre.md, CRE-9), so the workflow pushes
     * its result to `callbackUrl` instead.
     */
    workflow: workflowConfig(),
    paymentRpcUrls: paymentRpcUrls(),
    arc: {
      rpcUrl: env('ARC_RPC_URL'),
      address: env('VERDIKT_REGISTRY_ADDRESS'),
      deployBlock: (() => {
        const block = env('VERDIKT_REGISTRY_DEPLOY_BLOCK');
        return block === undefined ? undefined : BigInt(block);
      })()
    }
  };
}
