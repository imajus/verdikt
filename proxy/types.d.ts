// Ambient types for @verdikt/proxy. Global by design — no `export` in this file.

interface ProxyConfig {
  /** Agents call `<slug>.verdikt.bond`; the slug is the Host subdomain. */
  publicHost: string;
  ensCacheTtlMs: number;
  upstreamTimeoutMs: number;
  /** Off by default: a provider-authored `url` record is otherwise an SSRF primitive. */
  allowPrivateUpstream: boolean;
  /** The shared secret the enclave presents on the callback. Unset refuses every callback. */
  callbackToken?: string;
  /** `null` means paid calls are refused rather than relayed unverified. */
  workflow: {
    triggerUrl: string;
    workflowId: string;
    privateKey: string;
    callbackUrl: string;
    timeoutMs: number;
  } | null;
  arc: { rpcUrl?: string; address?: string; deployBlock?: bigint };
}

/** Everything the router reaches outside itself, injectable so tests need no network. */
interface ProxyDeps {
  config?: ProxyConfig;
  resolveServiceRecord?: (slug: string, options?: ResolveOptions) => Promise<ServiceRecord>;
  registry?: Pick<RegistryReader, 'getService'>;
  fetch?: typeof fetch;
  /** Absent means the proxy cannot verify a paid call and says so, rather than relaying one unverified. */
  workflow?: WorkflowClient | null;
  decodePayment?: (header: string) => Promise<DecodedPayment>;
  /** Injectable so a test can assert the id that comes back in the response headers. */
  newRequestId?: () => string;
  /** Backs the discovery API. Absent means /services answers 503. */
  marketplace?: (() => Promise<Marketplace>) | null;
}

/** A Durable Object stub: the client-side handle `namespace.get(id)` returns. */
interface DurableObjectStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Opaque — only ever round-tripped through `idFromName` and `get`. */
type DurableObjectId = unknown;

/** The one binding shape this proxy needs; not the full Workers Durable Object API. */
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/**
 * What `wrangler.jsonc` hands `worker.js`'s `fetch(request, env)`: the
 * `PENDING_VERIFICATION` Durable Object binding, plus everything
 * `loadConfig` reads — the same env-var names as `.env`, just sourced from
 * Workers vars/secrets instead of `process.env`.
 */
interface WorkerEnv {
  PENDING_VERIFICATION: DurableObjectNamespace;
  [key: string]: string | DurableObjectNamespace | undefined;
}

type VerificationFailure = 'workflow_timeout' | 'trigger_rejected' | 'run_failed';

/** What the proxy sends the enclave. Everything the judgement needs, and nothing else. */
interface VerificationRequest {
  serviceId: string;
  requestId: string;
  providerUrl: string;
  method: string;
  paymentHeader: string;
  /**
   * Which header name `paymentHeader` actually arrived as (`payment-signature`
   * in x402 v2, `x-payment` in v1). The enclave replays the payment to the
   * provider itself (Specification.md §2) and must send it back under the same
   * name — a v2 provider like Alchemy does not recognize `x-payment` at all.
   */
  paymentHeaderName: string;
  /**
   * The agent's request body, hex-encoded, or null for GET/HEAD and empty
   * bodies. The enclave's replay IS the paid call (Spike B, CRE-3), so a body
   * that does not travel with it never reaches the provider at all — a POST
   * service then sees an empty request and answers 4xx, which the status-only
   * fallback correctly declines to score as the provider's fault.
   */
  bodyHex: string | null;
  /** Replayed alongside the body: a provider handed bytes with no content type cannot parse them. */
  contentType: string | null;
  payer: string;
  /** Decimal string: JSON has no bigint, and the amount is in USDC minor units. */
  paidAmountMinorUnits: string;
  /** The raw `sla` ENS record. Resolved by the proxy — the SDK is the only file that knows ENS exists. */
  sla: string | null;
}

/**
 * What comes back. Carries the payload as well as the verdict: the trigger
 * response does not return it (Spike B, CRE-3) and the proxy cannot fetch it
 * itself, because an x402 payment settles once and the enclave's call was it.
 */
interface VerificationResult {
  /** `null` means no verdict was written — the 4xx carve-out. Not the same as no delivery. */
  outcome: SlaOutcome | null;
  mode: JudgementMode;
  reason: string | null;
  clauses: SlaClauseResult[];
  /** Arc transaction hash, or `null` when the write missed and the payload is being relayed anyway. */
  tx: string | null;
  status: number | null;
  headers: Record<string, string>;
  body: string;
  /** The DON consensus observation is capped; a larger response comes back cut, and flagged. */
  bodyTruncated?: boolean;
}

/**
 * Requests waiting on a callback from the enclave, keyed by requestId.
 *
 * `settle`/`cancel` return a `boolean` from the in-memory implementation and a
 * `Promise<boolean>` from the Durable-Object-backed one (pending-do.js) — a
 * network round trip either way, so every call site awaits it.
 */
interface PendingRegistry {
  readonly size: number;
  await(requestId: string, timeoutMs: number): Promise<VerificationResult>;
  settle(requestId: string, result: VerificationResult): boolean | Promise<boolean>;
  cancel(requestId: string, error: Error): boolean | Promise<boolean>;
}

interface WorkflowClient {
  verify(request: VerificationRequest): Promise<VerificationResult>;
  /** The callback route settles waiters here. */
  pending?: PendingRegistry;
}

interface WorkflowClientOptions {
  /** The CRE gateway. `https://01.gateway.zone-a.cre.chain.link` for a public registry. */
  triggerUrl: string;
  /** 64-char workflow id, from `cre workflow hash`. */
  workflowId: string;
  /**
   * The proxy's own key, whose address must appear in the workflow's
   * `authorizedKeys`. A fresh JWT is signed with it per request — the gateway's
   * token digests the body, so it cannot be a fixed string (CRE-9).
   */
  privateKey: string;
  /** Where the enclave pushes the finished verification back to. */
  callbackUrl: string;
  timeoutMs?: number;
  pending?: PendingRegistry;
  fetch?: typeof fetch;
}

type ChallengeBlockReason = 'owner_mismatch';

interface TriggerJwtOptions {
  /** The exact JSON-RPC body that will be sent — the token digests these bytes. */
  body: string;
  /** The proxy's own key; its address must appear in the workflow's `authorizedKeys`. */
  privateKey: string;
  /** Capped at 300 by the gateway. */
  ttlSeconds?: number;
  /** Unix seconds. Injectable so a test is not clock-dependent. */
  now?: number;
  /** Injectable for the same reason; a fresh UUID v4 otherwise. */
  jti?: string;
}
