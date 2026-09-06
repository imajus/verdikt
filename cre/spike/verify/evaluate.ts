// The evaluation step of the spike workflow.
//
// This is NOT `@verdikt/sla`'s engine and must not grow into one — Phase 1
// owns that. What it exists to demonstrate is the seam: `@verdikt/sla` is
// plain ESM JavaScript with ambient `.d.ts` types and no dependencies, and it
// resolves, typechecks and bundles into the CRE WASM binary from TypeScript.
// Once `evaluate()` has a body, this file is deleted and the workflow calls it
// directly — no second copy, nothing to drift.
//
// The logic below is deliberately the status-only fallback from
// Specification.md §1 plus one latency clause, with the same purity rules the
// real engine inherits: no I/O, no clock, no network. `latencyMs` arrives as
// an argument precisely so it can never be measured in here.

import { OUTCOME } from '@verdikt/sla';

export type SpikeObservation = {
  /** `null` when nothing usable came back at all. */
  status: number | null;
  body: string;
  latencyMs: number;
  latencyBudgetMs: number;
};

/**
 * Returns one of the three outcomes, or `null` meaning "write no verdict".
 *
 * `null` is the 4xx carve-out and it is load-bearing, not a tidy-up: a 4xx is
 * usually the provider correctly rejecting a malformed request, so scoring it
 * as a failure would let an agent farm refunds out of a provider's bond by
 * sending deliberate garbage (Specification.md §1).
 */
export const evaluateSpikeOrSkip = (observation: SpikeObservation): SlaOutcome | null => {
  if (observation.status === null) return OUTCOME.FAIL_UNREACHABLE;
  if (observation.status >= 400 && observation.status < 500) return null;
  if (observation.status >= 500) return OUTCOME.FAIL_CONFORMANCE;
  if (observation.latencyMs > observation.latencyBudgetMs) return OUTCOME.FAIL_CONFORMANCE;
  if (observation.body.length === 0) return OUTCOME.FAIL_CONFORMANCE;
  return OUTCOME.PASS;
};

/**
 * The workflow's convenience wrapper. Throws on the no-verdict case rather
 * than inventing one, so the caller has to decide what a skipped verdict means
 * rather than silently writing a PASS.
 */
export const evaluateSpike = (observation: SpikeObservation): SlaOutcome => {
  const outcome = evaluateSpikeOrSkip(observation);
  if (outcome === null) {
    throw new Error(`no verdict for status ${observation.status} — 4xx writes nothing`);
  }
  return outcome;
};
