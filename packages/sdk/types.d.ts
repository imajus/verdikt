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
   * The provider's upstream endpoint — where the proxy relays `<slug>.verdikt.bond/*`.
   *
   * Lives on ENS rather than on Arc because it is provider-authored, changes
   * without consensus significance, and the per-key EAC that already scopes
   * `sla` to the provider covers it for free. Putting it on Arc would mean a
   * chain write per URL change and a second provider-writable field on the
   * registry, and the proxy would need an Arc read on the unpaid leg it does
   * not otherwise need.
   */
  url: string | null;
  /**
   * The `sla` text record, raw and unparsed. Parsing and validation belong to
   * @verdikt/sla — this layer deliberately knows nothing about SLA schema.
   */
  sla: string | null;
  /** 0–1000, written hourly by the aggregate workflow. `null` before the first run. */
  conformance: number | null;
  /** 0–1000, written hourly by the aggregate workflow. `null` before the first run. */
  availability: number | null;
  /**
   * The subname registry's `latestOwner` for this slug's ENS token — `null`
   * when nobody has claimed the subname yet. Compared against the Arc
   * `provider` by the proxy's `checkOwnership`: a permissionless registrar
   * means the ENS claim and the Arc registration are two independent
   * first-come claims, and a mismatch means the two disagree about who runs
   * this slug.
   */
  owner: string | null;
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
  /** Skips the Universal Resolver lookup when the caller already knows it. */
  resolverAddress?: string;
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

/**
 * One `eth_call`, on whichever chain a payment names. Injected rather than
 * built inside the SDK so no endpoint is hardcoded here and tests stay offline
 * — the caller owns which chains it is willing to read.
 *
 * Returns the raw hex return data; `0x` for an address with no code.
 */
type EthCall = (request: { chainId: number; to: string; data: string }) => Promise<string>;

interface ArcOptions {
  /** Defaults to `ARC_RPC_URL`, then Arc Testnet's public RPC. */
  rpcUrl?: string;
  /** Defaults to `VERDIKT_REGISTRY_ADDRESS`. */
  address?: string;
  /** Where log scans start. Defaults to `VERDIKT_REGISTRY_DEPLOY_BLOCK`, else 0. */
  deployBlock?: bigint;
  /** Chunk size for `eth_getLogs`; most public RPCs cap the range. */
  maxBlockRange?: bigint;
  /** How many `eth_getLogs` chunks to have in flight at once. */
  scanConcurrency?: number;
}

interface LogRange {
  fromBlock?: bigint;
  toBlock?: bigint;
  /** Filters `VerdictWritten` to one service. */
  serviceId?: string;
}

/** Live registry state for one service. `deposit` is in Arc's 18-decimal native view. */
interface ServiceState {
  provider: string;
  status: ServiceStatus;
  deposit: bigint;
}

interface RegisteredService extends ServiceState {
  serviceId: string;
  /** Recoverable only from `ServiceRegistered` — keccak256 is one-way. */
  slug: string;
  registeredAtBlock: bigint | null;
}

/** `paidAmount` is in USDC minor units (6 decimals), as x402 carried it. */
interface VerdictRecord {
  serviceId: string;
  requestId: string;
  outcome: SlaOutcome;
  payer: string;
  paidAmount: bigint;
  /**
   * `keccak256(bytes(clauseId))` of the first clause that failed, or the zero
   * word. Match it by hashing the ids in the service's own SLA — see
   * `matchFailedClause`.
   */
  failedClause: string;
  blockNumber: bigint | null;
  transactionHash: string | null;
}

/** `amount` is in Arc's 18-decimal native view — it came out of the bond. */
interface RefundRecord {
  serviceId: string;
  requestId: string;
  payer: string;
  amount: bigint;
  blockNumber: bigint | null;
}

interface StoredVerdict {
  serviceId: string;
  outcome: SlaOutcome;
  payer: string;
  paidAmount: bigint;
  refundCredited: bigint;
  /** Unix seconds. */
  writtenAt: number;
  /** See `VerdictRecord.failedClause`. */
  failedClause: string;
}

interface RegistryReader {
  client: unknown;
  address: string;
  getService(serviceId: string): Promise<ServiceState>;
  /** `null` when no verdict is recorded for that requestId. */
  getVerdict(requestId: string): Promise<StoredVerdict | null>;
  getOwed(payer: string): Promise<bigint>;
  listServices(range?: LogRange): Promise<RegisteredService[]>;
  listVerdicts(range?: LogRange): Promise<VerdictRecord[]>;
  listRefunds(range?: LogRange): Promise<RefundRecord[]>;
}
