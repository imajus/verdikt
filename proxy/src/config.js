// Proxy configuration, read once at startup.

/**
 * The chains a *provider* can ask to be paid on, mapped from the name its env
 * var uses to the chain id its 402 names. Read only to ask a smart-contract
 * account whether it authorized a payment (ERC-1271).
 *
 * Names rather than ids in the environment, because `PAYMENT_BASE_RPC_URL` is
 * reviewable in a config file and `PAYMENT_RPC_URL_8453` is not. The id belongs
 * here, once, where it can be commented — an x402 challenge names its chain as
 * CAIP-2 (`eip155:8453`), so the lookup has to happen somewhere either way.
 *
 * A chain absent from this table, or present with no URL set, simply cannot
 * have contract payers verified on it — their payments are refused rather than
 * trusted, which is the safe direction.
 */
export const PAYMENT_CHAIN_IDS = Object.freeze({
  ETHEREUM: 1,
  BNB: 56,
  GNOSIS: 100,
  POLYGON: 137,
  // X Layer, which `pnl` prices on. Its Alchemy host is `xlayer-mainnet`;
  // `xlayer-testnet` is chain 1952 and answers for a different chain entirely.
  XLAYER: 196,
  // `pnl`'s challenge also advertises a `method="tempo"` payment path whose own
  // `methodDetails.chainId` is this one.
  TEMPO: 4217,
  BASE: 8453,
  ARBITRUM: 42161,
  LINEA: 59144,
  BASE_SEPOLIA: 84532
});

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
   * `PAYMENT_<NAME>_RPC_URL` for each chain in `PAYMENT_CHAIN_IDS`, keyed by
   * chain id for the reader that uses it. One variable per chain, so a single
   * chain can be repointed — or promoted to a `wrangler secret` — without
   * touching the rest.
   *
   * @returns {Record<number, string>}
   */
  const paymentRpcUrls = () => {
    /** @type {Record<number, string>} */
    const urls = {};
    for (const [name, chainId] of Object.entries(PAYMENT_CHAIN_IDS)) {
      const url = env(`PAYMENT_${name}_RPC_URL`);
      if (url) urls[chainId] = url;
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
