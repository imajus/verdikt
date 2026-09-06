// Ambient types for @verdikt/sdk. Global by design — no `export` in this file.

type EnsBackend = 'ensv2' | 'ensv1' | 'fixture';

/** Mirrors `IVerdiktRegistry.Status`. */
type ServiceStatus = 'NONE' | 'ACTIVE' | 'SUSPENDED' | 'DEREGISTERED';

/**
 * Everything Verdikt stores on a `<slug>.verdikt.eth` subname, resolved in one
 * call. Records that have not been written yet are `null`, not absent.
 */
interface ServiceRecord {
  slug: string;
  /** Fully qualified name, e.g. `weather.verdikt.eth`. */
  name: string;
  /** 0x-prefixed keccak256 of the slug — the same id the Arc registry uses. */
  serviceId: string;
  /**
   * The provider's payout wallet. The proxy compares this against the `payTo`
   * in a live 402 challenge and blocks before the agent signs anything on
   * mismatch (Specification.md §4).
   */
  address: string | null;
  /**
   * The `sla` text record, raw and unparsed. Parsing and validation belong to
   * @verdikt/sla — this layer deliberately knows nothing about SLA schema.
   */
  sla: string | null;
  /** 0–1000, written hourly by the aggregate workflow. `null` before the first run. */
  conformance: number | null;
  /** 0–1000, written hourly by the aggregate workflow. `null` before the first run. */
  availability: number | null;
  /** Which resolver actually answered — surfaced so the demo can be honest about the fallback. */
  backend: EnsBackend;
  /** Unix ms, for cache-age display. */
  resolvedAt: number;
}

interface ResolveOptions {
  /** Defaults to the Sepolia RPC from the environment. */
  rpcUrl?: string;
  /** Defaults to `verdikt.eth`. */
  parentName?: string;
  /** Cache TTL in ms. The proxy's passthrough branch caches the address record. */
  cacheTtlMs?: number;
  /** Force a backend instead of trying v2 then falling back. Mostly for tests. */
  backend?: EnsBackend;
}

interface WriteOptions {
  rpcUrl?: string;
  parentName?: string;
  /** Must be the key-scoped signer, not the provider's key. */
  privateKey: string;
}

/**
 * Recovered from the x402 payment payload, and returned only once the payer's
 * EIP-712 signature has been shown to cover `payer` and `amount`. Those two
 * are what the registrar needs for a refund, which is why no
 * request-to-payment correlation table exists anywhere in the system
 * (Specification.md §2, §3).
 */
interface DecodedPayment {
  /** Checksummed. Recovered from the signature, not read off the envelope. */
  payer: string;
  /**
   * Integer, minor units of `asset`. USDC has 6 decimals — Arc's *native*
   * USDC has 18, so this is not directly comparable with a deposit balance.
   * See `toArcNativeUnits`.
   */
  amount: bigint;
  /** The ERC-20 the amount is denominated in. */
  asset: string;
  /** CAIP-2, e.g. `eip155:5042002`. */
  network: string;
  /** The provider payout address the payment is authorized to. */
  payTo: string;
  /** x402 scheme name, e.g. `exact`. */
  scheme: string;
  /**
   * The authorization's 32-byte nonce, lowercased. Unique per authorization
   * and enforced as such by the facilitator at settlement, which makes it the
   * natural `requestId` for the registry's replay guard (Specification.md §3).
   */
  nonce: string;
  /** Unix seconds. */
  validAfter: bigint;
  /**
   * Unix seconds. Circle clamps this to roughly seven days out, so it bounds
   * the authorization's life and is not a freshness signal.
   */
  validBefore: bigint;
}

interface DecodeOptions {
  /**
   * The `accepts[]` entry from the provider's own 402. Supplying it turns the
   * EIP-712 domain from something the payer chose into something the provider
   * published, and is required to decode an x402 v1 header at all — v1
   * carries no copy of the requirements.
   */
  requirements?: Record<string, any>;
}

/**
 * The `X-PAYMENT-RESPONSE` settlement receipt. Unsigned — this is the
 * facilitator's report that the money moved, not proof of it.
 */
interface SettlementReceipt {
  success: boolean;
  /** Settlement transaction hash, or an empty string on failure. */
  transaction: string;
  network: string;
  /** The facilitator's view of the payer. `null` when absent. */
  payer: string | null;
  /** Present when the settled amount can differ from the authorized one. */
  amount: bigint | null;
  errorReason: string | null;
}
