// Ambient types for @verdikt/sla. Global by design — no `export` in this file.

/**
 * Per-call outcome. Mirrors `IVerdiktRegistry.Outcome`; the string <-> ordinal
 * mapping lives in `packages/sdk/registry.js`, which is the only place that
 * talks to the chain.
 */
type SlaOutcome = 'PASS' | 'FAIL' | 'DOWN';

/**
 * What the verifier observed for one paid call. This is the engine's entire
 * view of the world: `evaluate` performs no I/O, reads no clock and touches no
 * network, so anything it needs is in here (Tasks.md 1.3).
 */
interface SlaObservation {
  /**
   * HTTP status of the provider's response, or `null` when no usable response
   * came back at all — transport error, timeout, unparseable frame. `null` is
   * what makes an outcome `DOWN`; keeping that classification in
   * the engine rather than in the workflow keeps the refund trigger
   * deterministic and testable in one place.
   */
  status: number | null;
  headers: Record<string, string>;
  /** Parsed response body, or the raw string if it would not parse. */
  body: unknown;
  /** Measured by the caller, never inside `evaluate` — a clock read in the engine would break determinism. */
  latencyMs: number;
  /**
   * What the agent actually paid, as an integer in the asset's minor units
   * (USDC has 6, so 2500n = $0.0025). Never a float, never a decimal string:
   * price clauses compare with integer semantics only (Specification.md §1).
   *
   * This is the seam that keeps the engine independent of Spike C (Tasks.md
   * 0.4). However the `X-PAYMENT` header turns out to encode an amount —
   * and whether the amount ends up being read from the header or from the
   * settlement receipt — `decodePayment` normalises it to this before the
   * engine ever sees it.
   */
  paidAmount: bigint;
  /** Populated when `status` is null; surfaced by the dashboard as the failure reason. */
  transportError?: string;
}

/**
 * Clause types as they appear in a *result*. `delivery` is the implicit
 * predicate `evaluate` prepends to every evaluation — no provider declares it
 * and `id: 'delivery'` is rejected at validation time.
 */
type SlaClauseResultType = SlaClauseType | 'delivery';

interface SlaClauseResult {
  id: string;
  type: SlaClauseResultType;
  pass: boolean;
  /** Human-readable bound from the SLA, for the dashboard's per-verdict detail. */
  expected: string;
  /** Human-readable observed value. */
  actual: string;
}

/** First failure found by the JSON Schema subset, in a fixed traversal order. */
interface SchemaFailure {
  /** JSON pointer into the observed value; `''` is the root. */
  pointer: string;
  expected: string;
  actual: string;
}

interface SlaEvaluation {
  outcome: SlaOutcome;
  clauses: SlaClauseResult[];
}

/**
 * Result of the status-only fallback, used when the SLA could not be read or
 * would not parse (Specification.md §1).
 *
 * `outcome: null` means **write no verdict at all**. That is the 4xx carve-out:
 * a 4xx is usually the provider correctly rejecting a malformed request, so
 * scoring it as a failure would let an agent farm refunds by sending
 * deliberate garbage.
 */
interface SlaStatusOnlyEvaluation {
  outcome: SlaOutcome | null;
  clauses: [];
}

type SlaClauseType = 'schema' | 'latency' | 'priceRange';

/**
 * The provider-authored SLA, read verbatim from the `sla` ENS text record.
 *
 * Clause internals below are owned by Tasks.md Phase 1.1 and may still change.
 * The stable seam other packages code against is `evaluate` plus
 * `SlaObservation` and `SlaEvaluation` — nothing outside this package should
 * reach into a clause.
 */
interface SlaDocument {
  version: 1;
  clauses: SlaClause[];
}

type SlaClause = SlaSchemaClause | SlaLatencyClause | SlaPriceRangeClause;

interface SlaClauseBase {
  id: string;
  type: SlaClauseType;
}

/** Hand-rolled JSON Schema subset — no ajv (Tasks.md 1.2). */
interface SlaSchemaClause extends SlaClauseBase {
  type: 'schema';
  schema: Record<string, unknown>;
}

interface SlaLatencyClause extends SlaClauseBase {
  type: 'latency';
  maxMs: number;
}

/** Bounds are decimal integer strings in minor units; JSON has no bigint. */
interface SlaPriceRangeClause extends SlaClauseBase {
  type: 'priceRange';
  minMinorUnits: string;
  maxMinorUnits: string;
  asset: string;
}
