// Ambient types for @verdikt/proxy. Global by design — no `export` in this file.

interface ProxyConfig {
  port: number;
  host: string;
  /** Agents call `<slug>.verdikt.bond`; the slug is the Host subdomain. */
  publicHost: string;
  parentName?: string;
  ensCacheTtlMs: number;
  upstreamTimeoutMs: number;
  /** Off by default: a provider-authored `url` record is otherwise an SSRF primitive. */
  allowPrivateUpstream: boolean;
  arc: { rpcUrl?: string; address?: string; deployBlock?: bigint };
}

/** Everything the app reaches outside itself, injectable so tests need no network. */
interface ProxyDeps {
  config?: ProxyConfig;
  resolveServiceRecord?: (slug: string, options?: ResolveOptions) => Promise<ServiceRecord>;
  registry?: Pick<RegistryReader, 'getService'>;
  fetch?: typeof fetch;
  logger?: unknown;
}

type ChallengeBlockReason =
  | 'no_address_record'
  | 'unparseable_challenge'
  | 'challenge_has_no_pay_to'
  | 'pay_to_mismatch';
