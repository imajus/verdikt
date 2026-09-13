// Lives here, not in verify/workflow.ts, because that file bundles to WASM
// and cannot be unit tested — and this specific mistake takes money out of a
// provider's bond. Dependency-free so it can still bundle when it moves back.

/**
 * The `body` field of an HTTP capability request, spread into the request
 * rather than assigned — `body: undefined` throws inside the capability's
 * decoder before the request is sent, which the workflow's catch used to
 * read as a dead provider and score DOWN. Hand-rolled hex decode to keep this
 * dependency-free, and strict, so bad hex doesn't silently reach the provider
 * as the wrong bytes.
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
