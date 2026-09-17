// Lives here, not in verify/workflow.ts, for the reason that file states about
// itself: it bundles to WASM and cannot be unit tested, so logic that lives
// only there is logic nothing tests. This decides how much of a response the
// agent paid for actually gets delivered back to it, which is exactly that
// class of code. Dependency-free so it still bundles.

/**
 * How much serialized payload may leave the enclave, with headroom.
 *
 * The number this replaces was 20,000 characters, justified in-comment by "the
 * DON consensus observation is capped (25kb in simulation)". That was true when
 * it was written — at `a9bf43e` the payload came back as the handler's return
 * value and nothing else — and stopped being true when the callback push was
 * added (CRE-9, `17f8b0b`). `Consensus.ObservationSizeLimit` governs consensus
 * observations, and the body never becomes one: the DON-signed report carries
 * only `serviceId, requestId, outcome, payer, paidAmount, failedClause`, and
 * the relay reaches the proxy through a direct enclave-to-proxy POST that never
 * touches `donRuntime`. The cap was measured against a limit that does not
 * govern the path it constrains — root-caused as
 * [#88](https://github.com/imajus/verdikt/issues/88).
 *
 * Two limits do govern it, both from `cre/workflows/limits.json`:
 *
 *   - `ExecutionResponseLimit: 100kb` — the handler's return value;
 *   - `ConfidentialHTTP.RequestSizeLimit: 125kb` — the callback POST body.
 *
 * The smaller binds. 90kb leaves room for whatever framing the runtime puts
 * around a response it is measuring.
 *
 * Worth knowing which of those is *observed*: the simulator's startup banner
 * prints `ConfHTTP: req=125kb` (see `docs/evidence/cre-simulate-verify.log`)
 * and does not print `ExecutionResponseLimit` at all, so that one is read from
 * CRE's exported defaults rather than seen enforced. It is the tighter of the
 * two, which is the safe direction to be wrong in.
 */
export const RESPONSE_BUDGET_BYTES = 90_000;

/** Attempts `fitToBudget` gets before it stops shrinking and returns what it has. */
const FIT_ATTEMPTS = 8;

const encoder = new TextEncoder();

/**
 * @param {string} requestId
 * @param {Record<string, unknown>} result
 * @param {string} body
 * @param {boolean} bodyTruncated
 */
const serialize = (requestId, result, body, bodyTruncated) =>
  JSON.stringify({ requestId, ...result, body, bodyTruncated });

/**
 * Serialize the workflow's result, trimming the response body until it fits.
 *
 * Measured rather than guessed, because a character is not a byte here twice
 * over: the body may be UTF-8 multibyte, and JSON escaping can turn one
 * character into six. A fixed character cap that looks safe for ASCII is not
 * safe for a response full of quotes or emoji, and one that is safe for those
 * throws away most of the budget on the common case.
 *
 * Truncation is flagged, never silent. The agent paid for that body and has to
 * be able to tell it was cut — and a semantic claim judged on a clipped body
 * (docs/GenLayer.md) would be judged on evidence nobody said was
 * incomplete.
 *
 * @param {string} requestId
 * @param {Record<string, unknown>} result the relay fields plus the verdict fields
 * @param {number} [budget] overridable for tests; the production value is the default
 * @returns {string}
 */
export function fitToBudget(requestId, result, budget = RESPONSE_BUDGET_BYTES) {
  const fullBody = typeof result.body === 'string' ? result.body : '';
  let payload = serialize(requestId, result, fullBody, false);
  if (encoder.encode(payload).length <= budget) return payload;

  let body = fullBody;
  for (let attempt = 0; attempt < FIT_ATTEMPTS && body.length > 0; attempt += 1) {
    const over = encoder.encode(payload).length - budget;
    if (over <= 0) break;
    // Shrink by the measured overflow, then measure again: removing N
    // characters need not remove N bytes, so one pass is a guess and a loop is
    // an answer.
    body = body.slice(0, Math.max(0, body.length - Math.max(over, 1)));
    payload = serialize(requestId, result, body, true);
  }

  // Still over with nothing left to cut means the envelope itself — clause
  // detail, a long fallback reason — is what does not fit. Nothing here can fix
  // that by trimming a body, and returning a truthful oversized payload beats
  // returning a lie that fits.
  return payload;
}
