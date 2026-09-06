// What the hourly aggregate workflow computes (Specification.md §1, §2;
// Tasks.md 3.2).
//
// Plain ESM JS in the pnpm workspace for the same reason as `judge.js`: the
// simulate harness cannot run unattended (Spike B, CRE-1), and the subtlety
// here — what an absence of data means — is exactly the kind that has to be
// pinned by a test rather than by a comment.
//
// Pure: `now` is an argument, never a clock read.

import { aggregateWindow } from '@verdikt/sla';

/** Trailing window, per Specification.md §1. */
export const WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Scores for every registered service over the trailing window.
 *
 * Every ACTIVE or SUSPENDED service gets an entry, including ones with no
 * verdicts in the window at all. That is the point: a service nobody called is
 * presumed healthy and scores 1000, and it can only be *published* as 1000 if
 * it appears in this list. Deriving the list from the verdicts instead would
 * silently skip exactly those services and leave whatever stale number they
 * last had.
 *
 * DEREGISTERED services are dropped — their bond has gone home and their
 * subname is no longer a live listing.
 *
 * @param {ReputationInput} input
 * @returns {ServiceScores[]}
 */
export function reputationForWindow({ services, verdicts, now, windowSeconds = WINDOW_SECONDS }) {
  if (!Number.isFinite(now)) throw new Error('reputationForWindow: `now` must be a Unix timestamp in seconds');
  const since = now - windowSeconds;

  /** @type {Map<string, SlaOutcome[]>} */
  const byService = new Map();
  for (const service of services) {
    if (service.status === 'ACTIVE' || service.status === 'SUSPENDED') byService.set(service.serviceId, []);
  }
  for (const verdict of verdicts) {
    // Half-open window: a verdict exactly `windowSeconds` old has aged out, so
    // two runs an hour apart never both count the same boundary event.
    if (verdict.timestamp <= since || verdict.timestamp > now) continue;
    const bucket = byService.get(verdict.serviceId);
    // A verdict for a service that is not a live listing — deregistered since,
    // or never registered — is not scored. It has no subname to publish to.
    if (bucket) bucket.push(verdict.outcome);
  }

  return services
    .filter((service) => byService.has(service.serviceId))
    .map((service) => ({
      serviceId: service.serviceId,
      slug: service.slug,
      ...aggregateWindow(/** @type {SlaOutcome[]} */ (byService.get(service.serviceId)))
    }));
}

/**
 * Whether a freshly computed score is worth a transaction.
 *
 * One rolling write per service per hour is the budget (Specification.md §1),
 * and a service whose numbers have not moved does not need one — a missed or
 * skipped run just leaves the previous value standing, with no refund state to
 * reconcile. `published` being null (never written) always counts as changed.
 *
 * @param {ServiceScores} computed
 * @param {{ conformance: number|null, availability: number|null }} published
 * @returns {boolean}
 */
export const scoresChanged = (computed, published) =>
  computed.conformance !== published.conformance || computed.availability !== published.availability;
