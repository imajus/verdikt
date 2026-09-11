// @verdikt/sdk/payment — payment header decoding (Tasks.md 0.4, Spike C).
//
// WHAT IS REAL HERE AND WHAT IS NOT
//
// A real x402 v2 challenge (captured live from Alchemy, 2026-09-11) offers
// `scheme: "exact"` under (at least) two different asset transfer methods on
// the very same network — a plain ERC-3009 token transfer, and Circle's own
// `GatewayWalletBatched`. Both are IMPLEMENTED below, through one verifier:
// both payloads are the same ERC-3009 `TransferWithAuthorization` signature
// (confirmed against a real captured signature — see `verifyExact`'s doc for
// how the two are told apart), so there is one code path, not two.
//
// GatewayWalletBatched was refused entirely until 2026-09-11 (issue #41):
// its payload shape was believed unpublished, and "inventing one would prove
// nothing." A real captured `PAYMENT-SIGNATURE` header settled that — it
// recovers correctly against the Gateway contract as the EIP-712
// `verifyingContract`, using exactly the `name`/`version` the challenge's own
// `accepts[].extra` already supplies.
//
// The payer is *recovered from a signature* either way, not read out of a
// JSON field an attacker could edit — that is the security property Spike C
// was chasing, and it now covers every `exact` option a real challenge has
// been seen to offer.

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

/**
 * Whether decoding is backed by real verification rather than the fixture.
 *
 * Exported so a server can refuse to boot rather than fail per request. It is
 * true for every `exact` option a real challenge has been seen to offer,
 * including GatewayWalletBatched (issue #41) — a genuinely unrecognised
 * scheme still refuses, per header rather than at boot, because which scheme
 * an agent picks is not known until it arrives.
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
 * Alchemy call.
 *
 * `accepted` (v2 only) is returned alongside `scheme`/`network`, but only
 * ever used downstream to *select* among the challenge's own independently-
 * fetched options (`matchingOption`) when more than one shares scheme and
 * network — never to supply domain fields directly. See `matchingOption`'s
 * doc for why that boundary matters.
 *
 * @param {string} header raw payment header value
 * @returns {{ x402Version: number, scheme: string, network: string, payload: Record<string, any>, accepted: Record<string, any> | undefined }}
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
  const { x402Version, payload, accepted } = json;
  const scheme = json.scheme ?? accepted?.scheme;
  const network = json.network ?? accepted?.network;
  if (typeof scheme !== 'string' || typeof network !== 'string') {
    throw new Error('decodePayment: envelope is missing scheme or network');
  }
  if (!payload || typeof payload !== 'object') throw new Error('decodePayment: envelope is missing payload');
  return { x402Version, scheme, network, payload, accepted };
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
 * domain needs the asset (or, for GatewayWalletBatched, the Gateway contract)
 * as `verifyingContract`, plus a `name`/`version`. Those live in the
 * challenge, so verification is only possible with the challenge in hand —
 * which is a real constraint on the caller, not an implementation detail, and
 * is why `accepts` is a required argument rather than an optional one.
 *
 * scheme + network alone is not always enough: a real Alchemy challenge
 * offers `exact` twice on the same `eip155:8453` — once as a plain token
 * transfer, once as GatewayWalletBatched — so more than one candidate can
 * match. When that happens the v2 envelope's own `accepted.extra.name` picks
 * between them. This is safe precisely because it only *selects* among
 * options the real challenge already published; the domain fields
 * themselves are still read off the selected challenge entry, never off the
 * header. A header could at most choose a legitimate option it doesn't
 * actually hold a valid signature for, which just fails verification — it
 * cannot manufacture a domain that was never offered.
 *
 * @param {{ scheme: string, network: string, accepted?: Record<string, any> }} envelope
 * @param {any[]} accepts the challenge's `accepts` array
 */
function matchingOption(envelope, accepts) {
  const candidates = (accepts ?? []).filter(
    (entry) => entry?.scheme === envelope.scheme && entry?.network === envelope.network
  );
  if (candidates.length === 0) {
    throw new Error(
      `decodePayment: the challenge offers no ${envelope.scheme} option on ${envelope.network}, ` +
        'so there is nothing to verify this payment against'
    );
  }
  if (candidates.length === 1) return candidates[0];

  const wantedName = envelope.accepted?.extra?.name;
  const named = candidates.find((entry) => entry?.extra?.name === wantedName);
  if (!named) {
    throw new Error(
      `decodePayment: the challenge offers ${candidates.length} ambiguous ${envelope.scheme} options on ` +
        `${envelope.network}, and the payment names none of them`
    );
  }
  return named;
}

/**
 * Recover the paying agent and the amount it paid from an x402 payment
 * header, **verifying that both are signed by the payer**.
 *
 * That verification is the point, not a nicety. The refund target is read out
 * of this header; if `from` were merely asserted in JSON, anyone could name a
 * different payer and have someone else's refunds credited to them. It is not
 * asserted — the address is recovered from an ERC-3009 signature over the
 * exact `(from, to, value, validAfter, validBefore, nonce)` tuple, so editing
 * any of those invalidates it.
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
 * `allowStub` is checked before any of that: it is an unconditional
 * development override, not a fallback for schemes verification happens not
 * to reach. Checking it after real verification would mean it stops doing
 * anything the moment a scheme becomes implemented — which just happened to
 * GatewayWalletBatched (issue #41) and would happen again to the next one.
 *
 * @param {string} header raw payment header value
 * @param {{ accepts?: any[], allowStub?: boolean }} [options] `accepts` is the
 *   challenge's own array — required to verify anything.
 * @returns {Promise<DecodedPayment>}
 */
export async function decodePayment(header, options = {}) {
  const envelope = decodePaymentEnvelope(header);
  const allowStub = options.allowStub ?? process.env[STUB_OPT_IN] === 'true';
  if (allowStub) return { payer: DECODED_PAYMENT.payer, amount: DECODED_PAYMENT.amount };

  const option = options.accepts ? matchingOption(envelope, options.accepts) : null;

  if (envelope.scheme === 'exact' && option) {
    return verifyExact(envelope, option);
  }

  const named = option ? (option.extra?.name ?? 'unknown') : 'unknown (no accepts supplied)';
  throw new Error(
    `decodePayment: cannot verify a "${envelope.scheme}" payment using "${named}" (Spike C, Tasks.md 0.4). ` +
      `Refusing rather than trusting an unverified payer: this value decides who a refund is credited to. ` +
      `Set ${STUB_OPT_IN}=true to develop against the fixture, and never anywhere a real bond is at stake.`
  );
}

/**
 * Verifies any `exact`-scheme payment as an ERC-3009 `TransferWithAuthorization`
 * signature — which covers every asset transfer method a real challenge has
 * been seen to use, plain token transfer and GatewayWalletBatched alike.
 *
 * What tells them apart is which contract signed the message, not a method
 * label: `option.extra.verifyingContract`, when the challenge names one, is
 * Circle's Gateway contract standing in for the token — confirmed by
 * recovering the correct payer from a real captured GatewayWalletBatched
 * signature against exactly that domain (`name`/`version` straight off the
 * challenge's own `extra`, `verifyingContract` off `extra.verifyingContract`
 * rather than `asset`). A plain token transfer's `accepts` entry never
 * carries `extra.verifyingContract`, so it falls back to `option.asset` —
 * the same domain the original eip3009-only implementation always used.
 * There is nothing left to distinguish once that fallback exists: eip3009
 * *is* the general case, GatewayWalletBatched is a same-shaped signature
 * against a different contract.
 *
 * The domain comes from the challenge either way, never from the header: a
 * payer that could choose its own domain could sign a harmless message on
 * some other contract and present it here.
 *
 * @param {{ network: string, payload: Record<string, any> }} envelope
 * @param {any} option the matching `accepts` entry
 * @returns {Promise<DecodedPayment>}
 */
async function verifyExact(envelope, option) {
  const { signature, authorization } = envelope.payload;
  if (typeof signature !== 'string' || !authorization || typeof authorization !== 'object') {
    throw new Error('decodePayment: payload needs a signature and an authorization');
  }
  for (const field of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
    if (authorization[field] === undefined) {
      throw new Error(`decodePayment: authorization is missing ${field}`);
    }
  }

  const verifyingContract = option.extra?.verifyingContract ?? option.asset;
  const domain = {
    name: option.extra?.name,
    version: option.extra?.version,
    chainId: chainIdOf(envelope.network),
    verifyingContract: getAddress(verifyingContract)
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
