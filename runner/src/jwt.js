// Verifies the same `alg: "ETH"` JWT the real CRE gateway checks
// (proxy/src/jwt.js mints it, docs/spikes/cre.md CRE-9). This file
// intentionally does not import proxy/src/jwt.js — proxy is a Workers-only
// package with no exports for other packages to depend on (CLAUDE.md's
// package-boundaries section) — so the encoding here is a second copy of the
// same three-segment format. Keep the two in step; jwt.test.js below pins the
// digest and decode logic against fixtures shaped like proxy/src/jwt.test.js's
// so a divergence fails loudly instead of silently rejecting every trigger.

import { createHash } from 'node:crypto';
import { verifyPersonalMessage } from '@verdikt/sdk/signing';

export const TRIGGER_JWT_FAILURE = Object.freeze({
  MALFORMED: 'malformed_token',
  EXPIRED: 'expired',
  NOT_YET_VALID: 'not_yet_valid',
  DIGEST_MISMATCH: 'digest_mismatch',
  BAD_SIGNATURE: 'bad_signature',
  WRONG_SIGNER: 'wrong_signer'
});

export class TriggerJwtError extends Error {
  /** @param {string} failure @param {string} message */
  constructor(failure, message) {
    super(message);
    this.name = 'TriggerJwtError';
    this.failure = failure;
  }
}

/** @param {string} body */
const digestOf = (body) => `0x${createHash('sha256').update(body, 'utf8').digest('hex')}`;

/** @param {string} segment */
function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.MALFORMED, 'could not decode a JWT segment');
  }
}

/**
 * Verify a trigger JWT against the exact body string it was minted for, and
 * against the one signer address this runner accepts as "the proxy". A real
 * CRE gateway checks the signer against the workflow's `authorizedKeys` list;
 * this runner has no workflow-scoped list to consult (the simulator does not
 * expose one over HTTP), so it checks a single configured address instead —
 * narrower than production, which is the right direction for a stand-in.
 *
 * @param {{ authorization: string|null, body: string, expectedSignerAddress: string, maxAgeSeconds?: number, now?: number }} options
 * @returns {Promise<{ issuer: string, jti: string }>}
 */
export async function verifyTriggerJwt({ authorization, body, expectedSignerAddress, maxAgeSeconds = 300, now }) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.MALFORMED, 'missing Bearer authorization header');
  }
  const token = authorization.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.MALFORMED, 'not a three-part token');
  }
  const [headerSeg, payloadSeg, signatureSeg] = parts;
  const header = decodeSegment(headerSeg);
  const payload = decodeSegment(payloadSeg);
  if (header?.alg !== 'ETH' || header?.typ !== 'JWT') {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.MALFORMED, `unexpected header ${JSON.stringify(header)}`);
  }
  if (typeof payload?.digest !== 'string' || typeof payload?.exp !== 'number' || typeof payload?.iat !== 'number') {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.MALFORMED, 'payload is missing digest, iat or exp');
  }

  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  if (payload.exp < nowSeconds) {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.EXPIRED, `token expired at ${payload.exp}, now ${nowSeconds}`);
  }
  // A little slack for clock skew between the proxy's Worker and this host,
  // rather than the 300s MAX_TTL the gateway itself allows for `iat` drift.
  if (payload.iat > nowSeconds + 30) {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.NOT_YET_VALID, `token issued in the future: ${payload.iat}`);
  }
  if (payload.exp - payload.iat > maxAgeSeconds) {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.EXPIRED, `token TTL ${payload.exp - payload.iat}s exceeds ${maxAgeSeconds}s`);
  }

  const expectedDigest = digestOf(body);
  if (payload.digest !== expectedDigest) {
    // Binds the token to these exact bytes (proxy/src/jwt.js) — a mismatch
    // means either the body was tampered with in transit, or a token minted
    // for one request is being replayed against another.
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.DIGEST_MISMATCH, 'token digest does not match the request body');
  }

  let signature;
  try {
    signature = `0x${Buffer.from(signatureSeg, 'base64url').toString('hex')}`;
  } catch {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.MALFORMED, 'could not decode the signature segment');
  }
  const signedMessage = `${headerSeg}.${payloadSeg}`;
  const signatureOk = await verifyPersonalMessage(payload.iss, signedMessage, signature).catch(() => false);
  if (!signatureOk) {
    throw new TriggerJwtError(TRIGGER_JWT_FAILURE.BAD_SIGNATURE, 'signature does not recover to the claimed issuer');
  }
  if (payload.iss.toLowerCase() !== expectedSignerAddress.toLowerCase()) {
    throw new TriggerJwtError(
      TRIGGER_JWT_FAILURE.WRONG_SIGNER,
      `token signed by ${payload.iss}, expected ${expectedSignerAddress}`
    );
  }

  return { issuer: payload.iss, jti: payload.jti };
}
