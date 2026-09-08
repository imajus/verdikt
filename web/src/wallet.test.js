import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectWallet,
  ensureChain,
  getConnectedAccount,
  onAccountChange,
  resetWalletStateForTests
} from './wallet.js';

/** @param {{ requestResult?: Record<string, unknown>, throwOn?: string, switchError?: { code: number } }} [options] */
function fakeProvider({ requestResult = {}, throwOn, switchError } = {}) {
  const listeners = new Map();
  const provider = {
    request: vi.fn(async ({ method, params }) => {
      if (method === throwOn) throw new Error(`${method} failed`);
      if (method === 'eth_requestAccounts') return requestResult.accounts ?? ['0xAaAa000000000000000000000000000000AaAa'];
      if (method === 'eth_chainId') return requestResult.chainId ?? '0x1';
      if (method === 'wallet_switchEthereumChain') {
        if (switchError) {
          const error = new Error('unrecognized chain');
          /** @type {Error & { code?: number }} */ (error).code = switchError.code;
          throw error;
        }
        return null;
      }
      if (method === 'wallet_addEthereumChain') return null;
      throw new Error(`unexpected method ${method}`);
    }),
    on: vi.fn((event, fn) => listeners.set(event, fn)),
    removeListener: vi.fn((event) => listeners.delete(event)),
    _emit: (/** @type {string} */ event, /** @type {unknown[]} */ ...args) => listeners.get(event)?.(...args)
  };
  return provider;
}

/**
 * `wallet.js`'s `discoverProvider` does a synchronous EIP-6963
 * announce/request/remove dance on `window` itself — `addEventListener`,
 * `dispatchEvent`, AND `removeEventListener`, in that order. A stub missing
 * any one of the three throws mid-connect, so all three are provided here
 * once rather than separately at every call site.
 * @param {{ ethereum?: unknown }} [options]
 */
function fakeWindow({ ethereum } = {}) {
  return { ethereum, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() };
}

beforeEach(() => {
  resetWalletStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connectWallet', () => {
  it('requests accounts and returns the first one with the current chain', async () => {
    const provider = fakeProvider({ requestResult: { accounts: ['0xAaAa000000000000000000000000000000AaAa'], chainId: '0x2711' } });
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    const account = await connectWallet();
    expect(account.address).toBe('0xAaAa000000000000000000000000000000AaAa');
    expect(account.chainId).toBe(10001);
  });
  it('throws plainly when no provider is available', async () => {
    vi.stubGlobal('window', fakeWindow());
    await expect(connectWallet()).rejects.toThrow(/no wallet/i);
  });
  it('remembers the connected account for getConnectedAccount', async () => {
    const provider = fakeProvider();
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    expect(getConnectedAccount()).toBeNull();
    await connectWallet();
    expect(getConnectedAccount()?.address).toBe('0xAaAa000000000000000000000000000000AaAa');
  });
});

describe('ensureChain', () => {
  it('switches chains when the wallet already knows the chain', async () => {
    const provider = fakeProvider();
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    await connectWallet();
    await ensureChain(10001, { chainId: 10001, name: 'Arc Testnet', rpcUrl: 'https://rpc.testnet.arc.network' });
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x2711' }]
    });
  });
  it('adds the chain when the wallet does not recognise it (error code 4902)', async () => {
    const provider = fakeProvider({ switchError: { code: 4902 } });
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    await connectWallet();
    await ensureChain(10001, {
      chainId: 10001,
      name: 'Arc Testnet',
      rpcUrl: 'https://rpc.testnet.arc.network',
      nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 }
    });
    expect(provider.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'wallet_addEthereumChain' })
    );
  });
});

describe('onAccountChange', () => {
  it('notifies listeners when the wallet reports accountsChanged, and null on disconnect', async () => {
    const provider = fakeProvider();
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    await connectWallet();
    const seen = /** @type {(string|null)[]} */ ([]);
    const unsubscribe = onAccountChange((address) => seen.push(address));
    provider._emit('accountsChanged', ['0xBbBb000000000000000000000000000000BbBb']);
    provider._emit('accountsChanged', []);
    expect(seen).toEqual(['0xBbBb000000000000000000000000000000BbBb', null]);
    unsubscribe();
  });
  it('handles a reconnect after disconnect without a fresh connectWallet() call', async () => {
    const provider = fakeProvider();
    vi.stubGlobal('window', fakeWindow({ ethereum: provider }));
    await connectWallet();
    const seen = /** @type {(string|null)[]} */ ([]);
    const unsubscribe = onAccountChange((address) => seen.push(address));
    expect(() => provider._emit('accountsChanged', [])).not.toThrow();
    expect(() => provider._emit('accountsChanged', ['0xCcCc000000000000000000000000000000CcCc'])).not.toThrow();
    expect(seen).toEqual([null, '0xCcCc000000000000000000000000000000CcCc']);
    unsubscribe();
  });
});
