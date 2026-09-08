// Ambient types for @verdikt/web. Global by design — no `export` in this file.

interface MarketplaceDeps {
  registry: Pick<RegistryReader, 'listServices' | 'listVerdicts' | 'listRefunds'>;
  resolve: (slug: string) => Promise<ServiceRecord>;
}

/** One verdict as the dashboard shows it: the event, plus what it actually paid out. */
interface ListingVerdict extends VerdictRecord {
  /** In Arc's 18-decimal native view — it came out of the bond. Zero for a PASS. */
  refunded: bigint;
  /**
   * `failedClause` resolved against the SLA published now: the clause id, or
   * `null` when the verdict named none, or `'unknown'` when the SLA has been
   * edited since and no longer declares it.
   */
  failedClauseId: string | null;
}

interface Listing {
  serviceId: string;
  slug: string;
  name: string;
  provider: string;
  status: ServiceStatus;
  /** 18-decimal native view. */
  deposit: bigint;
  endpoint: string | null;
  payTo: string | null;
  /** `unreachable` means Sepolia did not answer — the listing is still real. */
  namingLayer: 'ok' | 'unreachable';
  /**
   * The ENS subname's owner and the Arc registration's provider disagree. The
   * proxy already refuses to route such a listing (`checkOwnership`) — this
   * is the same fact, surfaced for the marketplace to render rather than
   * silently list a service nobody can actually call.
   */
  contested: boolean;
  sla: SlaDocument | null;
  slaRaw: string | null;
  /** As published on ENS by the hourly workflow. `null` before its first run. */
  published: { conformance: number | null; availability: number | null };
  /** The same shared computation, shown only where nothing is published yet. */
  unpublished: ReputationScores;
  /** Newest first. */
  history: ListingVerdict[];
}

interface PlatformStats {
  services: number;
  active: number;
  suspended: number;
  /** 18-decimal native view. */
  bonded: bigint;
  verdicts: number;
  breakdown: Record<SlaOutcome, number>;
  refundCount: number;
  refunded: bigint;
  windowSeconds: number;
}

interface Marketplace {
  services: Listing[];
  stats: PlatformStats;
}
