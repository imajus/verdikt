// Building the CRE HTTP request the enclave replays the agent's paid call
// with. Small, but it lives here rather than in `verify/workflow.ts` for the
// reason that file's header gives: `cre workflow simulate` cannot run
// unattended, so logic that lives only there is logic nothing tests — and
// getting this wrong takes money out of a provider's bond.
//
// Dependency-free on purpose, like `packages/sla`: this bundles into the
// workflow's WASM.

/**
 * The `body` field of an HTTP capability request, as an object to spread into
 * the request rather than a value to assign.
 *
 * Spread, because the two states differ by whether the key is *present*:
 *
 *   - a request with a body carries `body` as a `Uint8Array`;
 *   - a request without one — every GET — must not carry the key at all.
 *
 * `body: undefined` is neither. The capability's protobuf decoder rejects it
 * with `cannot decode field capabilities.networking.http.v1alpha.Request.body
 * from JSON: expected Uint8Array, got undefined`, and it throws *before the
 * request is dispatched*. The workflow cannot tell that apart from a provider
 * that would not answer: its catch sets `status = null`, which is the one
 * input that makes `judge` return DOWN. So a GET-only service was scored DOWN
 * on every paid call, refunded out of its bond each time, while the provider
 * was never contacted and never paid — a verdict about a call that did not
 * happen, and there is no dispute layer to undo it.
 *
 * The hex decoding is hand-rolled rather than taken from viem so this module
 * keeps no dependencies, and it is strict: a body that does not decode throws
 * here instead of reaching the provider as the wrong bytes, which would be
 * judged against the SLA as if the agent had sent it.
 *
 * @param {string | null | undefined} bodyHex hex-encoded request body, or null/undefined for none
 * @returns {{ body?: Uint8Array }}
 */
export function requestBodyField(bodyHex) {
  if (bodyHex === null || bodyHex === undefined) return {};
  const digits = bodyHex.startsWith('0x') || bodyHex.startsWith('0X') ? bodyHex.slice(2) : bodyHex;
  if (digits.length % 2 !== 0) {
    throw new Error(`request body is not valid hex: odd number of digits (${digits.length})`);
  }
  const bytes = new Uint8Array(digits.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = digits.slice(index * 2, index * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new Error(`request body is not valid hex: ${JSON.stringify(pair)} at byte ${index}`);
    }
    bytes[index] = Number.parseInt(pair, 16);
  }
  return { body: bytes };
}
