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
 * Recovered from the x402 payment payload. Both fields are what the registrar
 * needs for a refund, which is why no request-to-payment correlation table
 * exists anywhere in the system (Specification.md §2, §3).
 */
interface DecodedPayment {
  payer: string;
  /** Integer, minor units. USDC has 6 decimals. */
  amount: bigint;
}
