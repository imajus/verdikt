// X-PAYMENT decoding (Tasks.md 0.4, Spike C).
//
// Every header here is built by SIGNING one with a real key, not by pasting a
// fixture blob. That matters: the property under test is that the payer and the
// amount are *cryptographically bound* to the header, and a hand-written
// fixture cannot demonstrate a binding — it can only assert one. So each
// tampering test below edits a signed header and expects the signature to stop
// matching, which is the only way to show the check is doing work.
//
// The challenge option is the real one the demo provider returns, copied from
// `fixtures/x402/challenge-402.json`.

import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { DECODED_PAYMENT } from '@verdikt/fixtures';
import { decodePayment, decodePaymentEnvelope, isPaymentDecodingImplemented } from './payment.js';

const PAYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');

/**
 * The Base Sepolia `exact`/eip3009 option, verbatim from the captured 402
 * except for `extra.assetTransferMethod` — real challenges don't reliably
 * carry it (Alchemy's own eip3009 option doesn't), so `verifyExact` no
 * longer reads it; keeping it here would test a field production code
 * ignores.
 */
const EIP3009_OPTION = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x5c33f23555313256b71f2b0a7ea1938425516505',
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' }
};

/** The Arc `GatewayWalletBatched` option, verbatim from the same challenge. */
const GATEWAY_OPTION = {
  scheme: 'exact',
  network: 'eip155:5042002',
  amount: '1',
  asset: '0x3600000000000000000000000000000000000000',
  payTo: '0x5c33f23555313256b71f2b0a7ea1938425516505',
  extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x0077777d7eba4688bdef3e311b846f25870a19b9' }
};

const ACCEPTS = [EIP3009_OPTION, GATEWAY_OPTION];

/**
 * Two options sharing both scheme and network — mirrors a real challenge
 * captured live from Alchemy (2026-09-11), which offers a plain token
 * transfer and GatewayWalletBatched as `exact`/`eip155:8453` side by side.
 * `matchingOption`'s scheme+network match alone cannot tell these apart.
 */
const COLLIDING_EIP3009_OPTION = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x0573c4dA7fC31E944e5FF959fEf3b42199C308B2',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' }
};

const COLLIDING_GATEWAY_OPTION = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x0573c4dA7fC31E944e5FF959fEf3b42199C308B2',
  maxTimeoutSeconds: 605400,
  extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee' }
};

const COLLIDING_ACCEPTS = [COLLIDING_EIP3009_OPTION, COLLIDING_GATEWAY_OPTION];

const AUTHORIZATION = {
  from: PAYER.address,
  to: '0x5c33f23555313256b71f2b0a7ea1938425516505',
  value: '2500',
  validAfter: '0',
  validBefore: '99999999999',
  nonce: `0x${'11'.repeat(32)}`
};

const TYPES = {
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
 * Sign an ERC-3009 authorization exactly as a paying agent would.
 *
 * `shape: 'v2'` builds the envelope the way a real x402 v2 `PAYMENT-SIGNATURE`
 * header does — `scheme`/`network` nested under `accepted` rather than at the
 * envelope's top level — matching a capture from a live Alchemy call (a real
 * paid call to portfolio.verdikt.bond, 2026-09-11). That capture is what
 * exposed the bug: `decodePaymentEnvelope` only looked at the top level, so
 * every v2 payment refused with "envelope is missing scheme or network" even
 * once the proxy's header-name detection was fixed.
 *
 * @param {{
 *   account?: import('viem/accounts').PrivateKeyAccount,
 *   authorization?: Record<string, string>,
 *   option?: { scheme: string, network: string, asset: string, payTo: string, extra: Record<string, any> },
 *   shape?: 'v1' | 'v2'
 * }} [args]
 */
async function signedHeader({ account = PAYER, authorization = AUTHORIZATION, option = EIP3009_OPTION, shape = 'v1' } = {}) {
  const signature = await account.signTypedData({
    domain: {
      name: option.extra.name,
      version: option.extra.version,
      chainId: Number(option.network.split(':')[1]),
      // GatewayWalletBatched signs against the Gateway contract named in
      // `extra.verifyingContract`, standing in for the token; a plain
      // transfer has no such field and signs against the token itself —
      // exactly `verifyExact`'s own fallback, mirrored here so this ever
      // produces a signature that verifier will actually accept.
      verifyingContract: /** @type {`0x${string}`} */ (option.extra.verifyingContract ?? option.asset)
    },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce
    }
  });
  const payload = { signature, authorization };
  return shape === 'v2'
    ? Buffer.from(
        JSON.stringify({
          x402Version: 2,
          payload,
          accepted: { scheme: option.scheme, network: option.network, extra: option.extra }
        })
      ).toString('base64')
    : header({ scheme: option.scheme, network: option.network, payload });
}

/** @param {Record<string, unknown>} envelope */
const header = (envelope) => Buffer.from(JSON.stringify({ x402Version: 2, ...envelope })).toString('base64');

/**
 * Re-encode a signed header with one authorization field edited.
 *
 * @param {Record<string, string>} patch
 * @param {{ option?: any }} [options]
 */
async function tamperedWith(patch, { option } = {}) {
  const original = JSON.parse(Buffer.from(await signedHeader(option ? { option } : {}), 'base64').toString('utf8'));
  original.payload.authorization = { ...original.payload.authorization, ...patch };
  return Buffer.from(JSON.stringify(original)).toString('base64');
}

describe('the envelope', () => {
  it('reads the x402 v1 fields out of base64 JSON, scheme/network at the top level', () => {
    const envelope = decodePaymentEnvelope(header({ scheme: 'exact', network: 'eip155:84532', payload: { a: 1 } }));
    expect(envelope).toMatchObject({ x402Version: 2, scheme: 'exact', network: 'eip155:84532' });
  });

  // x402 v2 renamed the header (X-PAYMENT → PAYMENT-SIGNATURE) and moved
  // scheme/network under `accepted` — verified against a real capture, see
  // `signedHeader`'s doc. `accepted`'s other fields are never read here.
  it('reads scheme/network out of `accepted` for a v2-shaped envelope', () => {
    const envelope = decodePaymentEnvelope(
      Buffer.from(
        JSON.stringify({
          x402Version: 2,
          payload: { a: 1 },
          accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0xshouldnotmatter' }
        })
      ).toString('base64')
    );
    expect(envelope).toMatchObject({ x402Version: 2, scheme: 'exact', network: 'eip155:8453' });
  });

  for (const [name, value] of [
    ['an empty string', ''],
    ['something that is not base64 JSON', 'not-base64-@@@'],
    ['base64 of a non-object', Buffer.from('42').toString('base64')],
    ['an envelope with no scheme', header({ network: 'eip155:1', payload: {} })],
    ['an envelope with no payload', header({ scheme: 'exact', network: 'eip155:1' })],
    [
      'a v2 envelope whose `accepted` has no scheme',
      Buffer.from(JSON.stringify({ x402Version: 2, payload: {}, accepted: { network: 'eip155:1' } })).toString('base64')
    ]
  ]) {
    it(`refuses ${name}`, () => {
      expect(() => decodePaymentEnvelope(/** @type {string} */ (value))).toThrow(/decodePayment/);
    });
  }
});

describe('decodePayment — the eip3009 path, which is an open standard end to end', () => {
  it('is reported as implemented, so a server need not refuse to boot', () => {
    expect(isPaymentDecodingImplemented()).toBe(true);
  });

  it('recovers the payer and the amount from a real signature', async () => {
    const payment = await decodePayment(await signedHeader(), { accepts: ACCEPTS });
    expect(payment.payer).toBe(PAYER.address);
    expect(payment.amount).toBe(2500n);
  });

  // Reproduces a production incident: a real paid call to portfolio.verdikt.bond
  // went through — money moved, response delivered — but wrote no verdict.
  // Root cause was two-layered: the proxy read only `x-payment` (fixed
  // separately in proxy/src/router.js), and even once that header is found,
  // this envelope shape rejected it before the signature was ever checked.
  it('recovers the payer from a v2-shaped envelope (PAYMENT-SIGNATURE), scheme/network nested under `accepted`', async () => {
    const payment = await decodePayment(await signedHeader({ shape: 'v2' }), { accepts: ACCEPTS });
    expect(payment.payer).toBe(PAYER.address);
    expect(payment.amount).toBe(2500n);
  });

  it('returns the amount as a bigint in minor units, never a string or a float', async () => {
    const payment = await decodePayment(await signedHeader(), { accepts: ACCEPTS });
    expect(typeof payment.amount).toBe('bigint');
  });

  /**
   * The whole security argument for reading a refund target out of this header.
   * If `from` were merely asserted, naming someone else would redirect their
   * refunds; because it is signed, editing it invalidates the signature.
   */
  it('rejects a header whose payer was swapped for someone else', async () => {
    const forged = await tamperedWith({ from: OTHER.address });
    await expect(decodePayment(forged, { accepts: ACCEPTS })).rejects.toThrow(/does not bind this payment/);
  });

  it('rejects a header whose amount was inflated after signing', async () => {
    const forged = await tamperedWith({ value: '999999999' });
    await expect(decodePayment(forged, { accepts: ACCEPTS })).rejects.toThrow(/does not bind this payment/);
  });

  // The signature covers the whole tuple, so the window is bound too — an
  // expired authorization cannot be revived by editing its own deadline.
  it('rejects a header whose validity window was edited', async () => {
    const forged = await tamperedWith({ validBefore: '1' });
    await expect(decodePayment(forged, { accepts: ACCEPTS })).rejects.toThrow(/does not bind this payment/);
  });

  it('rejects a signature from a key that is not the named payer', async () => {
    const forged = await signedHeader({ account: OTHER });
    await expect(decodePayment(forged, { accepts: ACCEPTS })).rejects.toThrow(/does not bind this payment/);
  });

  /**
   * A valid signature over the wrong payment. Crediting it would let an agent
   * pay somebody else and claim a refund on a call this provider never got.
   */
  it('rejects a payment validly signed to a different recipient', async () => {
    const elsewhere = { ...AUTHORIZATION, to: '0x00000000000000000000000000000000deadbeef' };
    const signed = await signedHeader({ authorization: elsewhere });
    await expect(decodePayment(signed, { accepts: ACCEPTS })).rejects.toThrow(/is paid at/);
  });

  // The domain is taken from the challenge, never from the header. A payer that
  // chose its own domain could sign something harmless elsewhere and replay it.
  it('will not verify against a challenge that offers no matching option', async () => {
    await expect(decodePayment(await signedHeader(), { accepts: [GATEWAY_OPTION] })).rejects.toThrow(
      /offers no exact option on eip155:84532/
    );
  });

  it('refuses an authorization that is missing a field rather than defaulting it', async () => {
    const envelope = JSON.parse(Buffer.from(await signedHeader(), 'base64').toString('utf8'));
    delete envelope.payload.authorization.nonce;
    const truncated = Buffer.from(JSON.stringify(envelope)).toString('base64');
    await expect(decodePayment(truncated, { accepts: ACCEPTS })).rejects.toThrow(/missing nonce/);
  });
});

describe('decodePayment — GatewayWalletBatched (issue #41)', () => {
  // Until 2026-09-11 this scheme refused unconditionally: its payload shape
  // was believed unpublished. A real captured `PAYMENT-SIGNATURE` header
  // settled that — it is the same ERC-3009 `TransferWithAuthorization`
  // `eip3009` already verifies, signed against the Gateway contract instead
  // of the token. These tests sign one the same way and check it recovers.
  it('recovers the payer and amount from a real GatewayWalletBatched signature', async () => {
    const payment = await decodePayment(await signedHeader({ option: GATEWAY_OPTION }), { accepts: ACCEPTS });
    expect(payment.payer).toBe(PAYER.address);
    expect(payment.amount).toBe(2500n);
  });

  it('signs against the Gateway contract, not the token — a token-domain signature does not verify', async () => {
    // Same authorization, but signed as if it were a plain transfer (domain
    // verifyingContract = option.asset, the token) rather than against the
    // Gateway contract GATEWAY_OPTION actually names. Proves the domain
    // selection is load-bearing, not incidental.
    const wrongDomainOption = { ...GATEWAY_OPTION, extra: { ...GATEWAY_OPTION.extra, verifyingContract: undefined } };
    const signed = await signedHeader({ option: wrongDomainOption });
    await expect(decodePayment(signed, { accepts: ACCEPTS })).rejects.toThrow(/does not bind this payment/);
  });

  it('rejects a GatewayWalletBatched header whose payer was swapped for someone else', async () => {
    const forged = await tamperedWith({ from: OTHER.address }, { option: GATEWAY_OPTION });
    await expect(decodePayment(forged, { accepts: ACCEPTS })).rejects.toThrow(/does not bind this payment/);
  });

  it('refuses a GatewayWalletBatched header with no real signature, rather than guessing its payload', async () => {
    const placeholderHeader = header({
      scheme: 'exact',
      network: 'eip155:5042002',
      payload: { somethingCircleShaped: true }
    });
    await expect(decodePayment(placeholderHeader, { accepts: ACCEPTS })).rejects.toThrow(
      /payload needs a signature and an authorization/
    );
  });
});

describe('decodePayment — disambiguating options that share scheme and network', () => {
  // Alchemy's real challenge offers a plain token transfer and
  // GatewayWalletBatched as `exact`/`eip155:8453` side by side — scheme and
  // network alone cannot tell `matchingOption` which one a header answers.
  const COLLIDING_AUTHORIZATION = { ...AUTHORIZATION, to: COLLIDING_EIP3009_OPTION.payTo };

  it('picks the GatewayWalletBatched option when the v2 envelope names it', async () => {
    const signed = await signedHeader({
      option: COLLIDING_GATEWAY_OPTION,
      authorization: COLLIDING_AUTHORIZATION,
      shape: 'v2'
    });
    const payment = await decodePayment(signed, { accepts: COLLIDING_ACCEPTS });
    expect(payment.payer).toBe(PAYER.address);
  });

  it('picks the plain-transfer option when the v2 envelope names it', async () => {
    const signed = await signedHeader({
      option: COLLIDING_EIP3009_OPTION,
      authorization: COLLIDING_AUTHORIZATION,
      shape: 'v2'
    });
    const payment = await decodePayment(signed, { accepts: COLLIDING_ACCEPTS });
    expect(payment.payer).toBe(PAYER.address);
  });

  it('refuses rather than guessing when nothing in the envelope names which option', async () => {
    // A v1 header carries no `accepted`, so there is no name to disambiguate
    // with — and picking either colliding option silently would mean
    // verifying against a domain the payer may never have signed.
    const v1Header = await signedHeader({ option: COLLIDING_EIP3009_OPTION, shape: 'v1' });
    await expect(decodePayment(v1Header, { accepts: COLLIDING_ACCEPTS })).rejects.toThrow(
      /2 ambiguous exact options on eip155:8453/
    );
  });

  it('refuses when the envelope names an option that matches none of the candidates', async () => {
    const mismatched = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        payload: { a: 1 },
        accepted: { scheme: 'exact', network: 'eip155:8453', extra: { name: 'Some Other Option' } }
      })
    ).toString('base64');
    await expect(decodePayment(mismatched, { accepts: COLLIDING_ACCEPTS })).rejects.toThrow(/ambiguous/);
  });
});

describe('decodePayment — schemes it does not implement', () => {
  it('refuses a scheme it has never seen, even with a matching accepts entry', async () => {
    const weirdOption = { scheme: 'weird', network: 'eip155:1', payTo: '0x1', extra: { name: 'Weird' } };
    const weirdHeader = header({ scheme: 'weird', network: 'eip155:1', payload: { anything: true } });
    await expect(decodePayment(weirdHeader, { accepts: [weirdOption] })).rejects.toThrow(/cannot verify a "weird" payment/);
  });

  it('refuses when no challenge was supplied, since nothing can be verified without one', async () => {
    await expect(decodePayment(await signedHeader())).rejects.toThrow(/no accepts supplied/);
  });
});

describe('decodePayment — the development stub', () => {
  // allowStub is an unconditional override, checked before any real
  // verification is attempted — including a header that would otherwise
  // verify for real, which is what proves it is not merely a fallback for
  // schemes decodePayment cannot yet reach.
  it('short-circuits to the fixture under an explicit opt-in, without attempting real verification', async () => {
    const payment = await decodePayment(await signedHeader(), { accepts: ACCEPTS, allowStub: true });
    expect(payment).toEqual({ payer: DECODED_PAYMENT.payer, amount: DECODED_PAYMENT.amount });
  });

  it('answers even a placeholder GatewayWalletBatched header under the opt-in', async () => {
    const placeholderHeader = header({ scheme: 'exact', network: 'eip155:5042002', payload: { somethingCircleShaped: true } });
    const payment = await decodePayment(placeholderHeader, { accepts: ACCEPTS, allowStub: true });
    expect(payment.amount).toBe(DECODED_PAYMENT.amount);
  });
});
