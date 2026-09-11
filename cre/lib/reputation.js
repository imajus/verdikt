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

// TEMPORARY (demo window) — revert to `7 * 24 * 60 * 60` after the hackathon.
//
// Specification.md §1 specifies a trailing **7-day** window and has not
// changed; this constant deliberately deviates from it for the duration of
// the demo, which is why the deviation lives here as a comment rather than as
// a quiet edit to the spec.
//
// WHAT IT BUYS. The window is both the analysis period and the block range
// fetched: `workflow.ts` divides it by `blockTimeSeconds` to get a
// `fromBlock`. On Arc's ~0.53s blocks, 7 days is 1,144,155 blocks — 39
// chunked `eth_getLogs` calls per run — against 163,451 blocks and 6 calls
// for one day. Faster runs and a far smaller failure surface during a live
// demo, at the cost of a ratio that reflects a day of traffic rather than a
// week.
//
// WHAT IT DOES NOT CHANGE. The `ServiceRegistered` scan is NOT windowed and
// must not be: it runs from the registry's deployment block because a service
// registered before the window is still a listing, and that log is the only
// place a serviceId maps back to its slug. Shortening it would empty the
// marketplace.
//
// EVERY OTHER SITE THIS TOUCHES is marked with the same `TEMPORARY (demo
// window)` marker — `grep -rn 'TEMPORARY (demo window)'` is the revert list.
// The dashboard footer derives its wording from this number
// (`web/src/lit-app.js`), so it needs no marker; the hard-coded prose in the
// landing page, the diagram and the proxy's discovery note does.
export const WINDOW_SECONDS = 24 * 60 * 60;

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
