/// <reference types="vite/client" />
// Ambient types for @verdikt/web. Global by design — no `export` in this file.

interface MarketplaceDeps {
  registry: Pick<RegistryReader, 'listServices' | 'listVerdicts' | 'listRefunds'>;
  resolve: (slug: string) => Promise<ServiceRecord>;
  /**
   * The semantic half, off GenLayer. `null` until a judge is deployed, and
   * that has to stay distinguishable from "deployed, nothing disputed": the
   * first means the dashboard cannot say anything, the second means there is
   * nothing to say.
   */
  genlayer?: GenLayerReader | null;
}

/** `UNKNOWN` is a contract newer than this bundle, shown rather than guessed at. */
type SemanticOutcome = 'OPEN' | 'BREACH' | 'MET' | 'UNDETERMINED' | 'CANCELLED' | 'UNKNOWN';

/**
 * One semantic claim, as GenLayer recorded it.
 *
 * Kept separate from `ListingVerdict` on purpose. A call can be CRE PASS and
 * semantically BREACH — two judgements of different questions, on different
 * chains, in different currencies — and merging them would destroy the only
 * fact worth showing (docs/roadmap/genlayer.md).
 */
interface SemanticSettlement {
  requestId: string;
  clauseId: string;
  slug: string;
  claimant: string;
  /** The clause text, frozen when the claim was filed. */
  criteria: string;
  outcome: SemanticOutcome;
  resolved: boolean;
  reasoning: string;
  /** All three in the settlement token's own units, which are pegged to nothing. */
  paidAmount: bigint;
  compensation: bigint;
  bounty: bigint;
}

interface GenLayerReader {
  judgeAddress: string;
  listSettlements(): Promise<SemanticSettlement[]>;
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
  /**
   * Semantic claims filed against this same call. Alongside the verdict, never
   * folded into it: a call can be CRE PASS and semantically BREACH, and that
   * pairing is the point.
   */
  settlements: SemanticSettlement[];
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
  /**
   * As published on ENS. `conformance` and `availability` come from the hourly
   * CRE workflow; `semanticConformance` from a separate aggregation over
   * GenLayer, written by its own signer. All `null` before a first run — and
   * `semanticConformance` stays null on any subname minted before that key
   * existed.
   */
  published: { conformance: number | null; availability: number | null; semanticConformance: number | null };
  /** The same shared computation, shown only where nothing is published yet. */
  unpublished: ReputationScores;
  /**
   * `null` means no judge is configured or GenLayer could not be read — the
   * dashboard can say nothing. `[]` means it read fine and nothing was
   * disputed. Different claims; the UI must not render them alike.
   */
  semantic: SemanticSettlement[] | null;
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

/** What a click on a marketplace column header sorts by (issue #64). */
type MarketplaceSortKey = 'reputation' | 'conformance' | 'availability' | 'requests' | 'deposit';

interface MarketplaceSort {
  key: MarketplaceSortKey;
  /** Every column's own best-first order is `desc`; a second click on the same column flips it. */
  direction: 'asc' | 'desc';
}

/**
 * The marketplace's client-side search/filter state (issue #64). The whole
 * list is already in `marketplaceCache.services`, so every field here just
 * re-filters that array — none of it triggers a new RPC call.
 */
interface MarketplaceFilters {
  /** Matched against slug and name, case-insensitively. */
  query: string;
  /** 0-1000, the same scale as `Listing.published.conformance`. */
  minConformance: number;
  minAvailability: number;
  /** Decimal USDC as typed, e.g. `"0.01"`. `''` means no cap. */
  maxPriceUsdc: string;
  /** Milliseconds as typed. `''` means no cap. */
  maxLatencyMs: string;
}

/** The SLA composer's model (forms/sla-draft.js). */
type SlaDraftClauseKind = 'schema' | 'latency' | 'priceRange';

/** `any` is a schema node with no single named `type`; its constraints ride in `extra`. */
type SlaDraftNodeType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'any';

interface SlaDraftNode {
  type: SlaDraftNodeType;
  /** Whether the parent object lists this field in `required`. Unused on the root. */
  required: boolean;
  /** Lower bound as typed: `minimum`, `minLength` or `minItems` by type. Empty means none. */
  min: string;
  max: string;
  /** Object members in the order the sample or schema listed them. */
  properties: Array<{ name: string; node: SlaDraftNode; ignored: boolean }>;
  items: SlaDraftNode | null;
  /** Keywords the tree has no control for, re-emitted verbatim. */
  extra: Record<string, unknown>;
}

interface SlaDraftClauseBase {
  kind: SlaDraftClauseKind;
  id: string;
  /** Once the provider edits the id it is never re-suggested. */
  idTouched: boolean;
  /** The id this clause carried in the published record, for the rename guard. */
  originalId: string | null;
  description: string;
}

interface SlaDraftSchemaClause extends SlaDraftClauseBase {
  kind: 'schema';
  /** A response body pasted to infer the tree from. */
  sample: string;
  /** A JSON Schema pasted or edited directly, the other way to author the tree. */
  schemaText: string;
  root: SlaDraftNode | null;
}

interface SlaDraftLatencyClause extends SlaDraftClauseBase {
  kind: 'latency';
  maxMs: string;
}

interface SlaDraftPriceClause extends SlaDraftClauseBase {
  kind: 'priceRange';
  /** In USDC as typed, e.g. `0.0025`; converted to minor units on serialization. */
  min: string;
  max: string;
  asset: string;
}

type SlaDraftClause = SlaDraftSchemaClause | SlaDraftLatencyClause | SlaDraftPriceClause;

interface SlaDraft {
  clauses: SlaDraftClause[];
  /** Original ids of published clauses the provider has removed this session. */
  removed: string[];
}

interface SlaDraftProblem {
  /** Index into `SlaDraft.clauses`. */
  clause: number;
  /** `id`, `maxMs`, `min`, `max`, `shape`, or a `/path.min` style pointer into a schema tree. */
  field: string;
  message: string;
}
