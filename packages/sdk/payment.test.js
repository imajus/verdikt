// Spike C's regression suite (Tasks.md 0.4).
//
// The positive cases here are cheap. The negative ones are the point: a
// decoder that returned the right payer for the good header and *also* for a
// tampered one would pass every test that only checked the happy path, and
// would hand the bond to whoever asked. Each rejection below is a way money
// could leave the deposit for the wrong reason.

import { describe, expect, it } from 'vitest';
import {
  ARC_TESTNET_NETWORK,
  ARC_TESTNET_USDC,
  DECODED_PAYMENT,
  FIXTURE_ATTACKER,
  FIXTURE_PAYER,
  PAYMENT_PAYLOAD,
  PAYMENT_REQUIRED_CHALLENGE,
  PRODUCTION_402_CHALLENGE,
  SETTLEMENT_RECEIPT,
  X_PAYMENT_HEADER,
  X_PAYMENT_HEADER_TAMPERED_AMOUNT,
  X_PAYMENT_HEADER_TAMPERED_PAYER,
  X_PAYMENT_RESPONSE_HEADER
} from '@verdikt/fixtures';
import { decodePayment, decodeSettlement, PaymentDecodeError } from './payment.js';
import { ARC_NATIVE_DECIMALS, PAYMENT_ASSET_DECIMALS, toArcNativeUnits } from './registry.js';

/** @param {unknown} value */
const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

/**
 * Re-encode the fixture payload with one path edited.
 * @param {(payload: any) => void} edit
 * @returns {string}
 */
function mutate(edit) {
  const payload = structuredClone(PAYMENT_PAYLOAD);
  edit(payload);
  return encode(payload);
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<string>}
 */
async function rejectionCode(promise) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentDecodeError);
    return /** @type {PaymentDecodeError} */ (error).code;
  }
  throw new Error('expected the decode to be rejected, but it resolved');
}

describe('decodePayment', () => {
  it('recovers the payer and amount from a GatewayWalletBatched header', async () => {
    await expect(decodePayment(X_PAYMENT_HEADER)).resolves.toEqual(DECODED_PAYMENT);
  });

  it('reports the amount in the asset minor units as a bigint', async () => {
    const { amount } = await decodePayment(X_PAYMENT_HEADER);
    expect(typeof amount).toBe('bigint');
    // $0.0025 at USDC's 6 decimals. If this ever reads 0.0025 or 2.5, the
    // boundary that keeps @verdikt/sla off the wire format has been crossed.
    expect(amount).toBe(2500n);
  });

  it('agrees with the provider 402 the payment answers', async () => {
    const decoded = await decodePayment(X_PAYMENT_HEADER);
    const [requirements] = PAYMENT_REQUIRED_CHALLENGE.accepts;
    expect(decoded.payTo).toBe(requirements.payTo);
    expect(decoded.asset).toBe(requirements.asset);
    expect(decoded.network).toBe(requirements.network);
    expect(decoded.amount).toBe(BigInt(requirements.amount));
  });

  it('carries the authorization nonce, so a refund has a replay key', async () => {
    const { nonce } = await decodePayment(X_PAYMENT_HEADER);
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(nonce).toBe(PAYMENT_PAYLOAD.payload.authorization.nonce);
  });

  it('is deterministic — the same header decodes identically every time', async () => {
    const first = await decodePayment(X_PAYMENT_HEADER);
    const second = await decodePayment(X_PAYMENT_HEADER);
    expect(second).toEqual(first);
  });

  describe('binding', () => {
    it('rejects a header naming a different payer over the real signature', async () => {
      expect(await rejectionCode(decodePayment(X_PAYMENT_HEADER_TAMPERED_PAYER))).toBe(
        'signer-mismatch'
      );
    });

    it('rejects an inflated amount', async () => {
      expect(await rejectionCode(decodePayment(X_PAYMENT_HEADER_TAMPERED_AMOUNT))).toBe(
        'signer-mismatch'
      );
    });

    it('rejects a redirected payTo', async () => {
      const header = mutate((p) => {
        p.accepted.payTo = FIXTURE_ATTACKER;
        p.payload.authorization.to = FIXTURE_ATTACKER;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('signer-mismatch');
    });

    it('rejects a declared amount that disagrees with the signed one', async () => {
      // Only the envelope is edited, so the signature still recovers — this is
      // caught by the cross-check rather than by recovery, which is why both
      // exist.
      const header = mutate((p) => {
        p.accepted.amount = '250000';
      });
      expect(await rejectionCode(decodePayment(header))).toBe('amount-mismatch');
    });

    it('rejects a declared payTo that disagrees with the signed one', async () => {
      const header = mutate((p) => {
        p.accepted.payTo = FIXTURE_ATTACKER;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('recipient-mismatch');
    });

    it('rejects a shifted validity window', async () => {
      const header = mutate((p) => {
        p.payload.authorization.validBefore = '9999999999';
      });
      expect(await rejectionCode(decodePayment(header))).toBe('signer-mismatch');
    });

    it('rejects a replaced nonce', async () => {
      const header = mutate((p) => {
        p.payload.authorization.nonce = `0x${'ab'.repeat(32)}`;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('signer-mismatch');
    });

    it('rejects a signing domain the payer did not sign under', async () => {
      // The domain is not itself signed, so it can be swapped freely. Swapping
      // it changes the digest and the recovered address stops matching.
      const header = mutate((p) => {
        p.accepted.extra.verifyingContract = ARC_TESTNET_USDC;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('signer-mismatch');
    });

    it('rejects a signature from another key', async () => {
      const header = mutate((p) => {
        p.payload.signature = `0x${'11'.repeat(65)}`;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('signer-mismatch');
    });
  });

  describe('malformed input', () => {
    it.each([
      ['empty', ''],
      ['not base64', 'not base64 at all!'],
      ['base64 of non-JSON', Buffer.from('hello', 'utf8').toString('base64')],
      ['base64 of a JSON array', encode([1, 2, 3])]
    ])('rejects a header that is %s', async (_label, header) => {
      expect(await rejectionCode(decodePayment(header))).toBe('malformed-header');
    });

    it('rejects a non-string header', async () => {
      // @ts-expect-error — the guard exists precisely for callers who ignore the type
      expect(await rejectionCode(decodePayment(undefined))).toBe('malformed-header');
    });

    it('rejects a hex-encoded amount rather than widening it', async () => {
      const header = mutate((p) => {
        p.accepted.amount = '0x9c4';
        p.payload.authorization.value = '0x9c4';
      });
      expect(await rejectionCode(decodePayment(header))).toBe('malformed-header');
    });

    it('rejects a payload with no authorization', async () => {
      const header = mutate((p) => {
        delete p.payload.authorization;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('unsupported-scheme');
    });

    it('rejects an unknown x402 version', async () => {
      const header = mutate((p) => {
        p.x402Version = 3;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('unsupported-version');
    });

    it('rejects an x402 v1 header, which carries no signing domain', async () => {
      const { authorization, signature } = PAYMENT_PAYLOAD.payload;
      const v1 = encode({
        x402Version: 1,
        scheme: 'exact',
        network: 'arc-testnet',
        payload: { authorization, signature }
      });
      expect(await rejectionCode(decodePayment(v1))).toBe('unsupported-version');
    });

    it('rejects a non-EVM network', async () => {
      const header = mutate((p) => {
        p.accepted.network = 'solana:mainnet';
      });
      expect(await rejectionCode(decodePayment(header))).toBe('unsupported-network');
    });

    it('rejects a payload whose extra names no EIP-712 domain', async () => {
      const header = mutate((p) => {
        delete p.accepted.extra;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('missing-eip712-domain');
    });

    it('rejects an ERC-6492 wrapped signature rather than guessing at it', async () => {
      // A counterfactual smart account's signature needs an on-chain ERC-1271
      // check. Failing loudly beats recovering an address that means nothing.
      const magic = '6492649264926492649264926492649264926492649264926492649264926492';
      const header = mutate((p) => {
        p.payload.signature = `${p.payload.signature}${magic}`;
      });
      expect(await rejectionCode(decodePayment(header))).toBe('smart-account-signature');
    });
  });

  describe('with the provider 402 supplied', () => {
    it('accepts a header that answers the challenge', async () => {
      const [requirements] = PAYMENT_REQUIRED_CHALLENGE.accepts;
      await expect(decodePayment(X_PAYMENT_HEADER, { requirements })).resolves.toEqual(
        DECODED_PAYMENT
      );
    });

    it('rejects a header that answers a different challenge', async () => {
      // The payer echoing its own requirements is the attacker-controlled
      // path; pinning them to the provider's live 402 closes it.
      const [requirements] = PRODUCTION_402_CHALLENGE.accepts;
      expect(await rejectionCode(decodePayment(X_PAYMENT_HEADER, { requirements }))).toBe(
        'requirements-mismatch'
      );
    });
  });
});

describe('decodeSettlement', () => {
  it('decodes the receipt from the paid response', async () => {
    await expect(decodeSettlement(X_PAYMENT_RESPONSE_HEADER)).resolves.toEqual({
      success: true,
      transaction: SETTLEMENT_RECEIPT.transaction,
      network: ARC_TESTNET_NETWORK,
      payer: FIXTURE_PAYER,
      amount: null,
      errorReason: null
    });
  });

  it('surfaces a failed settlement rather than throwing on it', async () => {
    // `success: false` is a normal answer, and the caller must be able to see
    // it: it is the case where no verdict may be written at all.
    const header = encode({
      success: false,
      transaction: '',
      network: ARC_TESTNET_NETWORK,
      errorReason: 'insufficient_funds'
    });
    const receipt = await decodeSettlement(header);
    expect(receipt.success).toBe(false);
    expect(receipt.errorReason).toBe('insufficient_funds');
  });

  it('reports the settled amount when the scheme carries one', async () => {
    const header = encode({ ...SETTLEMENT_RECEIPT, amount: '1800' });
    await expect(decodeSettlement(header)).resolves.toMatchObject({ amount: 1800n });
  });

  it('rejects a receipt with no success field', async () => {
    const header = encode({ transaction: '0x0', network: ARC_TESTNET_NETWORK });
    expect(await rejectionCode(decodeSettlement(header))).toBe('malformed-header');
  });
});

describe('toArcNativeUnits', () => {
  it('scales USDC minor units up to Arc native units', async () => {
    const { amount } = await decodePayment(X_PAYMENT_HEADER);
    expect(toArcNativeUnits(amount)).toBe(2_500_000_000_000_000n);
  });

  it('is the identity when the asset already has 18 decimals', () => {
    expect(toArcNativeUnits(7n, ARC_NATIVE_DECIMALS)).toBe(7n);
  });

  it('refuses to scale down rather than truncating', () => {
    expect(() => toArcNativeUnits(1n, 24)).toThrow(/unsupported asset decimals/);
  });

  it('refuses a number, so a float can never reach the refund cap', () => {
    // @ts-expect-error — same reason as above: the guard is for JS callers
    expect(() => toArcNativeUnits(2500)).toThrow(/non-negative bigint/);
  });

  it('keeps $1 paid and $1 bonded comparable', () => {
    // The invariant the helper exists for: one dollar paid must not compare as
    // a trillionth of one dollar bonded (Specification.md §3).
    const oneDollarPaid = 10n ** BigInt(PAYMENT_ASSET_DECIMALS);
    const oneDollarBonded = 10n ** BigInt(ARC_NATIVE_DECIMALS);
    expect(toArcNativeUnits(oneDollarPaid)).toBe(oneDollarBonded);
  });
});
