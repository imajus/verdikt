/// <reference types="vite/client" />
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
  sample: string;
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
  /** `id`, `maxMs`, `min`, `max`, `sample`, or a `/path.min` style pointer into a schema tree. */
  field: string;
  message: string;
}
