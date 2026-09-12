import { describe, expect, it } from 'vitest';
import { PAYMENT_CHAIN_IDS, loadConfig } from './config.js';

describe('payment-chain RPCs', () => {
  // The environment names a chain, an x402 challenge names a chain id, and this
  // is the only place the two meet. A wrong id here does not fail loudly — the
  // reader just finds no RPC for the chain the payment is on, and the payment is
  // refused as if the account had not validated it.
  it('keys a named RPC var by that chain’s id', () => {
    const config = loadConfig({ PAYMENT_BASE_RPC_URL: 'https://base.example/rpc' });
    expect(config.paymentRpcUrls).toEqual({ 8453: 'https://base.example/rpc' });
  });

  it('reads each configured chain independently', () => {
    const config = loadConfig({
      PAYMENT_BASE_RPC_URL: 'https://base.example/rpc',
      PAYMENT_XLAYER_RPC_URL: 'https://xlayer.example/rpc'
    });
    expect(config.paymentRpcUrls).toEqual({
      8453: 'https://base.example/rpc',
      196: 'https://xlayer.example/rpc'
    });
  });

  it('leaves out a chain that is unset or blank, rather than mapping it to nothing', () => {
    const config = loadConfig({ PAYMENT_BASE_RPC_URL: '   ' });
    expect(config.paymentRpcUrls).toEqual({});
  });

  it('ignores a name that is not a chain it knows', () => {
    expect(loadConfig({ PAYMENT_DOGECOIN_RPC_URL: 'https://nope.example' }).paymentRpcUrls).toEqual({});
  });

  // Pinned because these are the two the registered services actually price in,
  // and X Layer is the one most easily got wrong: its Alchemy host is
  // `xlayer-mainnet`, while `xlayer-testnet` is chain 1952 entirely.
  it('maps the chains the marketplace’s own providers charge on', () => {
    expect(PAYMENT_CHAIN_IDS.BASE).toBe(8453);
    expect(PAYMENT_CHAIN_IDS.XLAYER).toBe(196);
  });
});
