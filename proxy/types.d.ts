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
  /** `null` means paid calls are refused rather than relayed unverified. */
  workflow: { triggerUrl: string; statusUrl: string; authToken?: string } | null;
  arc: { rpcUrl?: string; address?: string; deployBlock?: bigint };
}

/** Everything the app reaches outside itself, injectable so tests need no network. */
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
  logger?: unknown;
}

type VerificationFailure = 'workflow_timeout' | 'trigger_rejected' | 'run_failed';

/** What the proxy sends the enclave. Everything the judgement needs, and nothing else. */
interface VerificationRequest {
  serviceId: string;
  requestId: string;
  providerUrl: string;
  method: string;
  paymentHeader: string;
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

interface WorkflowClient {
  verify(request: VerificationRequest): Promise<VerificationResult>;
}

interface WorkflowClientOptions {
  /** The CRE gateway's trigger endpoint for the `verdikt-verify` workflow. */
  triggerUrl: string;
  /** Where an execution's status and result are read back from. */
  statusUrl: string;
  /** Signed by the proxy's own key, which must be in the workflow's `authorizedKeys` (Spike B, CRE-4). */
  authToken?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type ChallengeBlockReason =
  | 'no_address_record'
  | 'unparseable_challenge'
  | 'challenge_has_no_pay_to'
  | 'pay_to_mismatch';
