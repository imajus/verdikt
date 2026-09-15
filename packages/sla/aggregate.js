// The trailing-window reputation ratios (Specification.md §1, Tasks.md 3.2).
//
// Lives in @verdikt/sla, not the workflow, for two reasons. It is spec §1's
// other half — the same verification model, aggregated — and it is pure, so it
// belongs where the other pure, dependency-free, bundles-into-the-enclave code
// is. The hourly workflow imports it; so can the dashboard, which must not
// derive a second, subtly different set of numbers from the same events.

/**
 * Both ratios are integers on a 0–1000 scale. ENS text records are strings, and
 * an integer sidesteps every decimal-format and locale question a fraction
 * would raise on the way through one.
 */
export const SCORE_SCALE = 1000;

/**
 * A window with no traffic scores full marks, not zero.
 *
 * Verdikt measures what agents actually bought (Requirements §4, "uptime
 * probing" is a non-goal), so absence of evidence is not evidence of failure.
 * Getting this backwards would brand every new listing as broken before it had
 * served a single request.
 */
export const NO_DATA_SCORE = SCORE_SCALE;

/**
 * Compute the marketplace ratios for one service over a window of verdicts.
 *
 * - **Conformance** = `PASS ÷ (PASS + FAIL)` — the quality of responses that
 *   *arrived*. `DOWN` leaves the denominator entirely: a call that returned
 *   nothing says nothing about whether the body would have conformed.
 * - **Availability** = `(PASS + FAIL) ÷ all` — whether they arrived at all.
 *
 * Division floors rather than rounds. With no dispute layer these numbers rank
 * a provider publicly, so the tie-break goes to *understating* a score rather
 * than to a provider whose 999.5 reads as a perfect 1000.
 *
 * @param {Iterable<SlaOutcome | { outcome: SlaOutcome }>} verdicts
 * @returns {ReputationScores}
 */
export function aggregateWindow(verdicts) {
  let pass = 0;
  let fail = 0;
  let down = 0;

  for (const entry of verdicts) {
    const outcome = typeof entry === 'string' ? entry : entry?.outcome;
    switch (outcome) {
      case 'PASS':
        pass += 1;
        break;
      case 'FAIL':
        fail += 1;
        break;
      case 'DOWN':
        down += 1;
        break;
      default:
        // A verdict we cannot classify must not be silently folded into a
        // denominator — that would move a published score for a reason nobody
        // can trace back to an event.
        throw new Error(`aggregateWindow: unknown outcome ${JSON.stringify(outcome)}`);
    }
  }

  const answered = pass + fail;
  const total = answered + down;

  return {
    // Nothing arrived, so nothing is known about body quality. Same principle
    // as an empty window: presumed healthy. Availability below reports the
    // outage that this is silent about.
    conformance: answered === 0 ? NO_DATA_SCORE : Math.floor((pass * SCORE_SCALE) / answered),
    availability: total === 0 ? NO_DATA_SCORE : Math.floor((answered * SCORE_SCALE) / total),
    counts: { pass, fail, down, total }
  };
}

/**
 * The semantic ratio: how often a dispute about *meaning* went against the
 * provider.
 *
 * A third score, deliberately not folded into `conformance`
 * (docs/roadmap/genlayer.md). The two measure different questions of different
 * traffic — every paid call versus only the disputed ones — and averaging them
 * would produce a number that answers neither. A provider with a spotless
 * `conformance` and a poor `semanticConformance` is exactly the case the whole
 * GenLayer leg exists to surface, and one merged figure would hide it.
 *
 * **Only `MET` and `BREACH` count.** `UNDETERMINED` and `CANCELLED` decided
 * nothing at all, and `OPEN` has not decided yet — folding any of them in
 * would let a claimant move a provider's public standing by filing claims that
 * never resolve. That is the same reasoning as `DOWN` leaving the conformance
 * denominator: a non-answer is not an answer.
 *
 * Empty scores 1000, on the same principle as the other two: absence of
 * evidence is not evidence of failure, and a provider nobody has disputed is
 * not thereby suspect.
 *
 * @param {Iterable<string | { outcome: string }>} settlements
 * @returns {SemanticScore}
 */
export function aggregateSemantic(settlements) {
  let met = 0;
  let breach = 0;
  let undecided = 0;

  for (const entry of settlements) {
    const outcome = typeof entry === 'string' ? entry : entry?.outcome;
    if (outcome === 'MET') met += 1;
    else if (outcome === 'BREACH') breach += 1;
    else if (outcome === 'OPEN' || outcome === 'UNDETERMINED' || outcome === 'CANCELLED') undecided += 1;
    else {
      // Same rule as `aggregateWindow`: a settlement nobody can classify must
      // not quietly join a denominator, or a published score moves for a
      // reason no event explains.
      throw new Error(`aggregateSemantic: unknown outcome ${JSON.stringify(outcome)}`);
    }
  }

  const decided = met + breach;
  return {
    semanticConformance: decided === 0 ? NO_DATA_SCORE : Math.floor((met * SCORE_SCALE) / decided),
    counts: { met, breach, undecided, decided }
  };
}
