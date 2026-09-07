// The CRE gateway's `alg: "ETH"` JWT (docs/spikes/cre.md, CRE-9).
//
// This is not a token you can put in a config file, which is what the first
// cut of `verification.js` assumed. The payload carries `digest` — the SHA256
// of the exact JSON-RPC body being sent — so a fresh JWT has to be minted for
// every request, from a private key whose address appears in the workflow's
// `authorizedKeys`.
//
// That signature is the access control on verdict-writing: an unauthorised
// caller cannot trigger the workflow, so it cannot manufacture a verdict
// (Spike B, CRE-4).

import { createHash, randomUUID } from 'node:crypto';
import { addressOf, signPersonalMessage } from '@verdikt/sdk/signing';

/** The gateway rejects anything longer-lived. */
export const MAX_TTL_SECONDS = 300;

/** @param {Uint8Array|Buffer} bytes */
const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** @param {object} value */
const encodeSegment = (value) => base64url(Buffer.from(JSON.stringify(value), 'utf8'));

/**
 * SHA256 of the request body, `0x`-prefixed.
 *
 * Takes the serialised string, not an object, and the caller must POST that
 * same string: `JSON.stringify` twice is not guaranteed to agree once anything
 * in the payload changes shape, and a digest over a different byte sequence
 * than was sent fails at the gateway with nothing useful to look at.
 *
 * @param {string} body
 */
export const digestOf = (body) => `0x${createHash('sha256').update(body, 'utf8').digest('hex')}`;

/**
 * Mint the `Authorization: Bearer` value for one `workflows.execute` call.
 *
 * @param {TriggerJwtOptions} options
 * @returns {Promise<string>}
 */
export async function mintTriggerJwt({ body, privateKey, ttlSeconds = 60, now, jti }) {
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('mintTriggerJwt: body must be the serialised JSON-RPC string that will be sent');
  }
  if (ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`mintTriggerJwt: ttlSeconds must be 1..${MAX_TTL_SECONDS}, got ${ttlSeconds}`);
  }
  const issuer = addressOf(privateKey);
  const issuedAt = now ?? Math.floor(Date.now() / 1000);

  const header = encodeSegment({ alg: 'ETH', typ: 'JWT' });
  const payload = encodeSegment({
    digest: digestOf(body),
    iss: issuer,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    // Replay protection. A UUID v4, per the gateway's docs.
    jti: jti ?? randomUUID()
  });

  // EIP-191 personal_sign over the two segments joined by a dot: the gateway
  // prefixes "Ethereum Signed Message:\n", keccak256s, and recovers.
  const signature = await signPersonalMessage(privateKey, `${header}.${payload}`);

  return `${header}.${payload}.${base64url(Buffer.from(signature.slice(2), 'hex'))}`;
}

/**
 * Split a minted token back into its parts. Exists for the tests — nothing in
 * the request path parses its own JWT.
 *
 * @param {string} token
 */
export function decodeTriggerJwt(token) {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error('decodeTriggerJwt: not a three-part token');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    signature: `0x${Buffer.from(signature, 'base64url').toString('hex')}`,
    signedMessage: `${header}.${payload}`
  };
}
