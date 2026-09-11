// @verdikt/sdk/payment — X-PAYMENT decoding (Tasks.md 0.4, Spike C).
//
// WHAT IS REAL HERE AND WHAT IS NOT
//
// The 402 challenge the demo provider actually returns offers three options
// (`fixtures/x402/challenge-402.json`), and they are not the same kind of
// thing:
//
//   - `scheme: "exact"` with `extra.assetTransferMethod: "eip3009"` — an open
//     standard end to end. The envelope is x402's own spec and the signature is
//     ERC-3009's `TransferWithAuthorization`. That path is IMPLEMENTED below,
//     signature verification included, and tested against signatures this repo
//     produces with a real key.
//   - `scheme: "exact"` with `extra.name: "GatewayWalletBatched"` — Circle's
//     own batched-gateway scheme. Its payload shape is not published, and
//     inventing one would prove nothing. That path is still UNSUPPORTED and
//     says so.
//
// So Spike C is half answered, and the half that is answered is the half that
// carries the security property: for `eip3009` the payer is *recovered from a
// signature*, not read out of a JSON field an attacker could edit.

import { getAddress, hashTypedData, recoverAddress } from 'viem';
import { DECODED_PAYMENT } from '@verdikt/fixtures';

/** Set `VERDIKT_ALLOW_STUB_PAYMENT=true` to develop against the fixture. */
export const STUB_OPT_IN = 'VERDIKT_ALLOW_STUB_PAYMENT';

/**
 * ERC-3009's authorization struct, field order exactly as the EIP defines it.
 * Reordering these silently changes the hash, so a valid signature would stop
 * verifying — or worse, a different message would start to.
 */
const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

/** The scheme/method pair this module can verify rather than merely parse. */
const EIP3009 = 'eip3009';

/**
 * Whether decoding is backed by real verification rather than the fixture.
 *
 * Exported so a server can refuse to boot rather than fail per request. It is
 * now true: the `eip3009` path is implemented. A caller that hands over a
 * `GatewayWalletBatched` header still gets a refusal, per header rather than at
 * boot, because which scheme an agent picks is not known until it arrives.
 */
export const isPaymentDecodingImplemented = () => true;

/**
 * Parse the payment envelope (`X-PAYMENT` in x402 v1, `PAYMENT-SIGNATURE` in
 * v2). No cryptography, no network.
 *
 * Split out from verification because the envelope is the part every scheme
 * shares — while `payload` is scheme-specific and only some of them are
 * knowable. The two versions disagree on where `scheme`/`network` live: v1
 * puts them at the envelope's top level (`{x402Version, scheme, network,
 * payload}`); v2 nests them under `accepted`, the `accepts` option the payer
 * says it is answering (`{x402Version, payload, accepted: {scheme, network,
 * ...}}`) — confirmed against a real `PAYMENT-SIGNATURE` capture from a live
 * Alchemy call. Only `accepted.scheme`/`accepted.network` are read here;
 * `accepted`'s other fields (asset, extra) are never trusted as the EIP-712
 * domain — see `matchingOption`'s doc for why that boundary matters.
 *
 * @param {string} header raw payment header value
 * @returns {{ x402Version: number, scheme: string, network: string, payload: Record<string, any> }}
 */
export function decodePaymentEnvelope(header) {
  if (typeof header !== 'string' || header.length === 0) {
    throw new Error('decodePayment: header must be a non-empty string');
  }
  let json;
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new Error('decodePayment: header is not base64-encoded JSON');
  }
  if (!json || typeof json !== 'object') throw new Error('decodePayment: header did not decode to an object');
  const { x402Version, payload } = json;
  const scheme = json.scheme ?? json.accepted?.scheme;
  const network = json.network ?? json.accepted?.network;
  if (typeof scheme !== 'string' || typeof network !== 'string') {
    throw new Error('decodePayment: envelope is missing scheme or network');
  }
  if (!payload || typeof payload !== 'object') throw new Error('decodePayment: envelope is missing payload');
  return { x402Version, scheme, network, payload };
}

/**
 * The chain id out of a CAIP-2 `eip155:<id>` network string.
 *
 * @param {string} network
 * @returns {number}
 */
function chainIdOf(network) {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`decodePayment: unsupported network "${network}" (expected CAIP-2 eip155:<chainId>)`);
  return Number(match[1]);
}

/**
 * Which `accepts` option a header is answering.
 *
 * The header names its scheme and network but NOT the asset, and the EIP-712
 * domain needs the asset as `verifyingContract` plus the token's own `name` and
 * `version`. Those live in the challenge, so verification is only possible with
 * the challenge in hand — which is a real constraint on the caller, not an
 * implementation detail, and is why this is a required argument rather than an
 * optional one.
 *
 * @param {{ scheme: string, network: string }} envelope
 * @param {any[]} accepts the challenge's `accepts` array
 */
function matchingOption(envelope, accepts) {
  const option = (accepts ?? []).find(
    (entry) => entry?.scheme === envelope.scheme && entry?.network === envelope.network
  );
  if (!option) {
    throw new Error(
      `decodePayment: the challenge offers no ${envelope.scheme} option on ${envelope.network}, ` +
        'so there is nothing to verify this payment against'
    );
  }
  return option;
}

/**
 * Recover the paying agent and the amount it paid from an x402 `X-PAYMENT`
 * header, **verifying that both are signed by the payer**.
 *
 * That verification is the point, not a nicety. The refund target is read out
 * of this header; if `from` were merely asserted in JSON, anyone could name a
 * different payer and have someone else's refunds credited to them. For
 * `eip3009` it is not asserted — the address is recovered from an ERC-3009
 * signature over the exact `(from, to, value, validAfter, validBefore, nonce)`
 * tuple, so editing any of those invalidates it.
 *
 * Async because the documented fallback for schemes whose binding cannot be
 * checked from the header is to read the settlement receipt instead, which is a
 * network call. Keeping the signature async means taking that fallback later
 * does not change every call site.
 *
 * `amount` is normalised to an integer in the asset's minor units so that
 * @verdikt/sla never depends on how the header encodes it. On Arc that is the
 * 6-decimal ERC-20 view, not the 18-decimal native one — `VerdiktRegistry`
 * converts (`NATIVE_PER_MINOR_UNIT`) before capping a refund against the bond.
 *
 * @param {string} header raw `X-PAYMENT` header value
 * @param {{ accepts?: any[], allowStub?: boolean }} [options] `accepts` is the
 *   challenge's own array — required to verify anything.
 * @returns {Promise<DecodedPayment>}
 */
export async function decodePayment(header, options = {}) {
  const envelope = decodePaymentEnvelope(header);
  const allowStub = options.allowStub ?? process.env[STUB_OPT_IN] === 'true';

  const option = options.accepts ? matchingOption(envelope, options.accepts) : null;
  const method = option?.extra?.assetTransferMethod;

  // The scheme string alone does not distinguish these: the demo challenge
  // offers `exact` twice, once as eip3009 and once as GatewayWalletBatched.
  // It is `extra` that says which, so `extra` is what is branched on.
  if (envelope.scheme === 'exact' && method === EIP3009) {
    return verifyEip3009(envelope, option);
  }

  if (allowStub) return { payer: DECODED_PAYMENT.payer, amount: DECODED_PAYMENT.amount };

  const named = option ? (method ?? option?.extra?.name ?? 'unknown') : 'unknown (no accepts supplied)';
  throw new Error(
    `decodePayment: cannot verify a "${envelope.scheme}" payment using "${named}" (Spike C, Tasks.md 0.4). ` +
      'Only the eip3009 asset transfer method is implemented, because its payload is an open standard and ' +
      "GatewayWalletBatched's is not published. Refusing rather than trusting an unverified payer: this value " +
      `decides who a refund is credited to. Set ${STUB_OPT_IN}=true to develop against the fixture, and never ` +
      'anywhere a real bond is at stake.'
  );
}

/**
 * @param {{ network: string, payload: Record<string, any> }} envelope
 * @param {any} option the matching `accepts` entry
 * @returns {Promise<DecodedPayment>}
 */
async function verifyEip3009(envelope, option) {
  const { signature, authorization } = envelope.payload;
  if (typeof signature !== 'string' || !authorization || typeof authorization !== 'object') {
    throw new Error('decodePayment: eip3009 payload needs a signature and an authorization');
  }
  for (const field of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
    if (authorization[field] === undefined) {
      throw new Error(`decodePayment: authorization is missing ${field}`);
    }
  }

  // The domain comes from the challenge, never from the header: a payer that
  // could choose its own domain could sign a harmless message on some other
  // contract and present it here.
  const domain = {
    name: option.extra?.name,
    version: option.extra?.version,
    chainId: chainIdOf(envelope.network),
    verifyingContract: getAddress(option.asset)
  };
  if (typeof domain.name !== 'string' || typeof domain.version !== 'string') {
    throw new Error('decodePayment: the challenge option is missing extra.name or extra.version for the EIP-712 domain');
  }

  const message = {
    from: getAddress(authorization.from),
    to: getAddress(authorization.to),
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce
  };

  const recovered = await recoverAddress({
    hash: hashTypedData({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: 'TransferWithAuthorization',
      message
    }),
    signature: /** @type {`0x${string}`} */ (signature)
  });

  if (getAddress(recovered) !== message.from) {
    throw new Error(
      `decodePayment: signature does not bind this payment to ${message.from} (recovered ${getAddress(recovered)}). ` +
        'Refusing: the payer named here is who a refund would be credited to.'
    );
  }

  // `payTo` is checked because the signature binds `to` as tightly as `from`.
  // A payment signed to somebody else's address is a valid signature over the
  // wrong payment, and crediting it here would let an agent claim a refund on
  // a call this provider was never paid for.
  if (getAddress(option.payTo) !== message.to) {
    throw new Error(
      `decodePayment: payment is authorized to ${message.to}, but this service is paid at ${getAddress(option.payTo)}`
    );
  }

  return { payer: message.from, amount: message.value };
}
