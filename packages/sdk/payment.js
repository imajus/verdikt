// @verdikt/sdk/payment — X-PAYMENT decoding (Tasks.md 0.4, Spike C).
//
// WHAT SPIKE C ESTABLISHED
//
// `X-PAYMENT` is base64(JSON) of an x402 v2 PaymentPayload. Under both the
// vanilla `exact` scheme and Circle's batched one, `payload` is an EIP-3009
// `TransferWithAuthorization` message plus an EIP-712 signature over it:
//
//   { authorization: { from, to, value, validAfter, validBefore, nonce },
//     signature }
//
// The payer is `authorization.from` and the amount is `authorization.value`,
// and both sit *inside the signed struct*. So the answer to the question the
// spike existed to ask — are they bound to the payer's signature or merely
// asserted? — is bound. Naming someone else as payer means forging their
// signature over this exact message. That is why this file recovers the
// signer and refuses to return anything when it does not match `from`: a
// decode that skipped that step would be indistinguishable from a decode of
// an attacker-authored blob, and `owed[payer]` is credited straight from what
// this returns (Specification.md §3).
//
// WHAT IT DOES NOT ESTABLISH — and the reason `decodeSettlement` exists too.
// A valid signature is an authorization to pay, not a payment. It says the
// payer agreed to move `value`; it does not say Gateway moved it. The
// authorization stays valid for seven days (Circle clamps `validBefore` to
// `now + 7d + 100s`), so `validBefore` is not a freshness signal either, and
// nothing in the header alone stops a payer from presenting a well-formed
// authorization that will never settle and collecting a refund against it.
// The enclave must confirm the settlement receipt before writing a verdict.
// docs/spikes/C-x402-payment.md §4 has the full argument.
//
// The two schemes differ in one place only: the EIP-712 domain. Vanilla
// `exact` signs against the USDC token contract with the token's own
// name/version; Circle's batched scheme signs against the GatewayWallet with
// name `GatewayWalletBatched`. `eip712DomainOf` below is the whole difference,
// which is what lets the proxy relay whatever a provider advertises
// (Specification.md §2) instead of hard-coding one scheme.

import { getAddress, isAddress, recoverTypedDataAddress } from 'viem';

/**
 * The EIP-3009 struct, byte-identical in @x402/evm and
 * @circle-fin/x402-batching. Private: callers get `decodePayment`, not the
 * ability to re-derive a hash their own way.
 */
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

/**
 * Exactly @x402/core's `Base64EncodedRegex` — standard alphabet, no
 * base64url. Deliberately not more permissive: anything a facilitator would
 * reject at settlement must be rejected here too, or the enclave could write
 * a verdict for a payment that was never going to go through.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** A plain 65-byte ECDSA signature. ERC-6492 wrappers are longer and handled below. */
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * ERC-6492's trailing magic bytes. A signature ending in these comes from a
 * smart account that is not deployed yet; validating it needs an on-chain
 * call, which this file deliberately does not make.
 */
const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';

/**
 * Why every failure is one error type with a `code`: the caller is the CRE
 * workflow, and its only sane response to any of these is the same one —
 * refuse to write a verdict. The code is for the operator reading logs, not
 * for control flow.
 */
export class PaymentDecodeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'PaymentDecodeError';
    this.code = code;
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  throw new PaymentDecodeError(code, `decodePayment: ${message}`);
}

/**
 * @param {string} header
 * @param {string} what
 * @returns {unknown}
 */
function decodeBase64Json(header, what) {
  if (typeof header !== 'string' || header.length === 0) {
    fail('malformed-header', `${what} must be a non-empty string`);
  }
  if (!BASE64.test(header)) {
    fail('malformed-header', `${what} is not standard base64`);
  }
  let text;
  try {
    text = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    fail('malformed-header', `${what} is not decodable base64`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('malformed-header', `${what} does not decode to JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('malformed-header', `${what} does not decode to a JSON object`);
  }
  return value;
}

/**
 * A decimal integer string as x402 puts on the wire. Rejects `0x` forms,
 * signs, exponents and leading zeros, so `amount` cannot arrive as something
 * `BigInt()` would happily widen into a different number than a facilitator
 * read.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {bigint}
 */
function uintField(value, field) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail('malformed-header', `${field} must be a decimal integer string`);
  }
  return BigInt(/** @type {string} */ (value));
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string} checksummed
 */
function addressField(value, field) {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    fail('malformed-header', `${field} must be an address`);
  }
  return getAddress(/** @type {string} */ (value));
}

/**
 * Rebuild the EIP-712 domain the payer signed under.
 *
 * The domain is not itself covered by the signature, so it arrives
 * attacker-controlled like everything else in the header. That does not let
 * anyone name a different payer — no choice of domain makes a signature
 * recover to an address whose key you do not hold — but it does mean the
 * domain proves nothing on its own. Checking it against the provider's real
 * 402 is the caller's job, via the `requirements` option.
 *
 * @param {Record<string, any>} accepted
 * @returns {{ name: string, version: string, chainId: number, verifyingContract: `0x${string}` }}
 */
function eip712DomainOf(accepted) {
  const network = accepted.network;
  if (typeof network !== 'string') fail('malformed-header', 'accepted.network is missing');
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) {
    fail('unsupported-network', `accepted.network must be eip155:<chainId>, got "${network}"`);
  }

  const extra = accepted.extra;
  if (extra === null || typeof extra !== 'object') {
    fail('missing-eip712-domain', 'accepted.extra is missing — cannot rebuild the signing domain');
  }
  if (typeof extra.name !== 'string' || typeof extra.version !== 'string') {
    fail('missing-eip712-domain', 'accepted.extra.name and .version are required');
  }

  // Circle's batched scheme signs against the GatewayWallet; vanilla `exact`
  // signs against the token. Falling back to `asset` is what makes this
  // decoder work for a provider that never touches Gateway.
  const verifyingContract =
    extra.verifyingContract === undefined
      ? addressField(accepted.asset, 'accepted.asset')
      : addressField(extra.verifyingContract, 'accepted.extra.verifyingContract');

  return {
    name: extra.name,
    version: extra.version,
    chainId: Number(match[1]),
    verifyingContract: /** @type {`0x${string}`} */ (verifyingContract)
  };
}

/**
 * Recover the paying agent and the amount it paid from an x402 `X-PAYMENT`
 * header, and refuse to return either unless the payer's signature covers
 * both.
 *
 * Async because signature recovery is, and because the ERC-1271 path this
 * file does not yet walk would need a network call — see the
 * `smart-account-signature` code below. Header parsing itself is synchronous
 * and does no I/O, which matters: this runs inside the enclave.
 *
 * `amount` is an integer in the asset's minor units (USDC: 6 decimals), taken
 * from the *signed* `authorization.value` rather than from the unsigned
 * `accepted.amount`. The two are cross-checked and a mismatch is an error, so
 * @verdikt/sla never depends on how the header encodes a price. Note that Arc
 * settles the bond in native USDC at 18 decimals — see `toArcNativeUnits` in
 * ./registry.js before comparing this against a deposit.
 *
 * @param {string} header raw `X-PAYMENT` header value
 * @param {DecodeOptions} [options]
 * @returns {Promise<DecodedPayment>}
 * @throws {PaymentDecodeError}
 */
export async function decodePayment(header, options = {}) {
  const envelope = /** @type {Record<string, any>} */ (decodeBase64Json(header, 'header'));

  // x402 v1 put `{ scheme, network, payload }` at the top level and carried no
  // copy of the requirements, so the EIP-712 domain — the token's name and
  // version — simply is not in the header. There is nothing to recover
  // against. Rejecting is the honest answer; a caller holding the provider's
  // 402 can pass it as `requirements`.
  if (envelope.x402Version === 1) {
    if (!options.requirements) {
      fail(
        'unsupported-version',
        'x402 v1 headers carry no `accepted`, so the EIP-712 domain cannot be ' +
          'rebuilt from the header alone — pass the provider 402 as options.requirements'
      );
    }
  } else if (envelope.x402Version !== 2) {
    fail('unsupported-version', `unsupported x402Version: ${String(envelope.x402Version)}`);
  }

  const accepted = options.requirements ?? envelope.accepted;
  if (accepted === null || typeof accepted !== 'object') {
    fail('malformed-header', 'payload is missing `accepted`');
  }

  // A caller that has the provider's live 402 should hand it over: it turns
  // the domain from something the payer chose into something the provider
  // published. Compared on the fields that decide where money goes, not on
  // the whole object — providers add advisory fields (`price`, `paymentInfo`)
  // that differ harmlessly between the challenge and the echoed copy.
  if (options.requirements && envelope.accepted) {
    for (const field of ['network', 'asset', 'payTo', 'scheme']) {
      const echoed = envelope.accepted[field];
      const required = options.requirements[field];
      const equal =
        field === 'asset' || field === 'payTo'
          ? typeof echoed === 'string' &&
            typeof required === 'string' &&
            echoed.toLowerCase() === required.toLowerCase()
          : echoed === required;
      if (!equal) {
        fail(
          'requirements-mismatch',
          `accepted.${field} in the header does not match the provider's 402`
        );
      }
    }
  }

  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object') {
    fail('malformed-header', 'payload is missing');
  }

  const authorization = payload.authorization;
  if (authorization === null || typeof authorization !== 'object') {
    fail(
      'unsupported-scheme',
      'payload.authorization is missing — only EIP-3009 TransferWithAuthorization ' +
        'schemes (`exact`, Circle batched) can be decoded'
    );
  }

  const signature = payload.signature;
  if (typeof signature !== 'string') {
    fail('malformed-header', 'payload.signature is missing');
  }
  if (signature.toLowerCase().endsWith(ERC6492_SUFFIX)) {
    fail(
      'smart-account-signature',
      'ERC-6492 wrapped signature: the payer is an undeployed smart account, ' +
        'so validating this needs an on-chain ERC-1271 call this decoder does not make'
    );
  }
  if (!SIGNATURE.test(signature)) {
    fail('malformed-header', 'payload.signature is not a 65-byte ECDSA signature');
  }

  const from = addressField(authorization.from, 'authorization.from');
  const to = addressField(authorization.to, 'authorization.to');
  const value = uintField(authorization.value, 'authorization.value');
  const validAfter = uintField(authorization.validAfter, 'authorization.validAfter');
  const validBefore = uintField(authorization.validBefore, 'authorization.validBefore');

  if (typeof authorization.nonce !== 'string' || !BYTES32.test(authorization.nonce)) {
    fail('malformed-header', 'authorization.nonce must be 32 bytes of hex');
  }
  const nonce = authorization.nonce.toLowerCase();

  const domain = eip712DomainOf(accepted);

  // The declared price and the signed one must agree. They can only diverge
  // if someone edited the envelope after the payer signed it, and picking
  // either without saying so would decide silently how much gets refunded.
  const declaredAmount = uintField(accepted.amount, 'accepted.amount');
  if (declaredAmount !== value) {
    fail(
      'amount-mismatch',
      `accepted.amount (${declaredAmount}) disagrees with the signed ` +
        `authorization.value (${value})`
    );
  }

  const payTo = addressField(accepted.payTo, 'accepted.payTo');
  if (payTo !== to) {
    fail(
      'recipient-mismatch',
      'accepted.payTo disagrees with the signed authorization.to — the payment ' +
        'is not authorized to the provider this challenge names'
    );
  }

  let recovered;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { from, to, value, validAfter, validBefore, nonce },
      signature: /** @type {`0x${string}`} */ (signature)
    });
  } catch (cause) {
    fail('signer-mismatch', `signature does not recover: ${String(cause)}`);
  }

  // The whole point of the file.
  if (recovered !== from) {
    fail(
      'signer-mismatch',
      `signature recovers to ${recovered}, not the declared payer ${from} — ` +
        'refusing to name a payer the signature does not cover'
    );
  }

  return Object.freeze({
    payer: from,
    amount: value,
    asset: addressField(accepted.asset, 'accepted.asset'),
    network: `eip155:${domain.chainId}`,
    payTo,
    scheme: typeof accepted.scheme === 'string' ? accepted.scheme : '',
    nonce,
    validAfter,
    validBefore
  });
}

/**
 * Decode the `X-PAYMENT-RESPONSE` settlement receipt the provider returns on
 * the paid 200.
 *
 * This is the half of the story `decodePayment` cannot tell. The verdict path
 * needs both: `decodePayment` says who owes what and binds it to a signature,
 * this says whether the money actually moved. Write a verdict on a request
 * whose receipt is absent or `success: false` and the bond pays out against a
 * payment that never happened.
 *
 * Note the receipt's own `payer` is not signed by anyone — it is the
 * facilitator's word. Trust `decodePayment`'s payer for the refund target and
 * use this only to confirm settlement, cross-checking that the two agree.
 *
 * @param {string} header raw `X-PAYMENT-RESPONSE` header value
 * @returns {Promise<SettlementReceipt>}
 * @throws {PaymentDecodeError}
 */
export async function decodeSettlement(header) {
  const receipt = /** @type {Record<string, any>} */ (
    decodeBase64Json(header, 'settlement header')
  );

  if (typeof receipt.success !== 'boolean') {
    fail('malformed-header', 'settlement receipt is missing `success`');
  }
  if (typeof receipt.transaction !== 'string') {
    fail('malformed-header', 'settlement receipt is missing `transaction`');
  }
  if (typeof receipt.network !== 'string') {
    fail('malformed-header', 'settlement receipt is missing `network`');
  }

  return Object.freeze({
    success: receipt.success,
    transaction: receipt.transaction,
    network: receipt.network,
    payer: receipt.payer === undefined ? null : addressField(receipt.payer, 'receipt.payer'),
    // Present for schemes where the settled amount can differ from the
    // authorized one (`upto`). When it is there it, not the authorization,
    // is what was actually taken.
    amount: receipt.amount === undefined ? null : uintField(receipt.amount, 'receipt.amount'),
    errorReason: typeof receipt.errorReason === 'string' ? receipt.errorReason : null
  });
}
