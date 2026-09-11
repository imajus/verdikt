import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWallet, disconnectWallet, ensureChain, getConnectedAccount, onAccountChange, resetWalletStateForTests, restoreWallet, walletClientFor } from './wallet.js';
import { getSession } from './session.js';

const mock = vi.hoisted(() => ({ init: vi.fn(), injected: vi.fn(() => ({})) }));
vi.mock('@web3-onboard/core', () => ({ default: mock.init }));
vi.mock('@web3-onboard/injected-wallets', () => ({ default: mock.injected }));
const ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ARC = { chainId: 5042002, name: 'Arc Testnet', rpcUrl: 'https://rpc.testnet.arc.network', nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 } };
const SEPOLIA = { chainId: 11155111, name: 'Sepolia', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' };

/** @type {any} */ let api;
/** @type {any[]} */ let wallets;
/** @type {(wallets: any[]) => void} */ let notify;
const unsubscribe = vi.fn();
function wallet(address = ADDRESS, chainId = ARC.chainId) {
  return { label: 'Injected wallet', accounts: [{ address }], chains: [{ id: `0x${chainId.toString(16)}` }], provider: { request: vi.fn(async () => `0x${chainId.toString(16)}`) } };
}
/** @param {any[]} next */
function emit(next) { wallets = next; notify(wallets); }
function signedIn() { localStorage.setItem('verdikt.session', JSON.stringify({ address: ADDRESS, chainId: ARC.chainId, expiresAt: Date.now() + 60000 })); }

beforeEach(() => {
  resetWalletStateForTests();
  vi.clearAllMocks();
  const storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (/** @type {string} */ key) => storage.get(key) ?? null, setItem: (/** @type {string} */ key, /** @type {string} */ value) => storage.set(key, value), removeItem: (/** @type {string} */ key) => storage.delete(key) });
  wallets = [wallet()];
  api = {
    connectWallet: vi.fn(async () => wallets),
    disconnectWallet: vi.fn(async () => emit([])),
    setChain: vi.fn(async ({ chainId }) => {
      wallets[0].provider.request.mockResolvedValue(chainId);
      emit([{ ...wallets[0], chains: [{ id: chainId }] }]);
      return true;
    }),
    state: { get: () => ({ wallets }), select: vi.fn(() => ({ subscribe: (/** @type {(wallets: any[]) => void} */ fn) => { notify = fn; return { unsubscribe }; } })) }
  };
  mock.init.mockReturnValue(api);
});
afterEach(() => { resetWalletStateForTests(); vi.unstubAllGlobals(); });

describe('Onboard connection state', () => {
  it('starts automatic restoration on load and preserves the matching session when Onboard reports the wallet', async () => {
    signedIn();
    await restoreWallet();
    expect(mock.init).toHaveBeenCalledWith(expect.objectContaining({ connect: { autoConnectLastWallet: true } }));
    expect(api.connectWallet).not.toHaveBeenCalled();
    // Onboard initially emits no wallets, then restores the extension.
    const restored = wallets;
    emit([]);
    expect(getConnectedAccount()).toBeNull();
    expect(getSession()?.address).toBe(ADDRESS);
    emit(restored);
    expect(getConnectedAccount()?.address).toBe(ADDRESS);
    expect(getSession()?.address).toBe(ADDRESS);
  });
  it('invalidates saved authentication if the restored wallet now exposes another account', async () => {
    signedIn();
    await restoreWallet();
    emit([wallet(OTHER)]);
    expect(getConnectedAccount()?.address).toBe(OTHER);
    expect(getSession()).toBeNull();
  });
  it('opens wallet selection and configures both networks with injected support', async () => {
    expect(await connectWallet()).toEqual({ address: ADDRESS, chainId: ARC.chainId });
    expect(api.connectWallet).toHaveBeenCalledOnce();
    expect(mock.injected).toHaveBeenCalledOnce();
    expect(mock.init.mock.calls[0][0].chains).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '0x4cef52', token: 'USDC' }),
      expect.objectContaining({ id: '0xaa36a7', token: 'ETH' })
    ]));
  });
  it('handles cancelled selection without creating a connection', async () => {
    wallets = [];
    await expect(connectWallet()).rejects.toThrow('no wallet selected');
    expect(getConnectedAccount()).toBeNull();
  });
  it('updates accounts and invalidates SIWE before notifying the UI', async () => {
    await connectWallet(); signedIn();
    const listener = vi.fn(() => expect(getSession()).toBeNull());
    onAccountChange(listener);
    emit([{ ...wallets[0], accounts: [{ address: OTHER }] }]);
    expect(getConnectedAccount()?.address).toBe(OTHER);
    expect(listener).toHaveBeenCalledWith(OTHER, true);
  });
  it('preserves address authentication on chain changes but blocks writes to the wrong network', async () => {
    await connectWallet(); signedIn();
    const listener = vi.fn(); onAccountChange(listener);
    emit([{ ...wallets[0], chains: [{ id: '0x1' }] }]);
    expect(getConnectedAccount()?.chainId).toBe(1);
    expect(listener).toHaveBeenCalledWith(ADDRESS, false);
    expect(getSession()?.address).toBe(ADDRESS);
    expect(() => walletClientFor(ARC)).toThrow('required network');
  });
  it('reuses an unexpired session when reconnecting the same address after a reload', async () => {
    signedIn();
    await connectWallet();
    expect(getSession()?.address).toBe(ADDRESS);
    resetWalletStateForTests();
    await connectWallet();
    expect(getSession()?.address).toBe(ADDRESS);
  });
  it('drops a saved session when connecting a different address', async () => {
    signedIn(); wallets = [wallet(OTHER)];
    await connectWallet();
    expect(getSession()).toBeNull();
  });
  it('does not revive an expired session on connection', async () => {
    localStorage.setItem('verdikt.session', JSON.stringify({ address: ADDRESS, chainId: ARC.chainId, expiresAt: Date.now() - 1 }));
    await connectWallet();
    expect(getSession()).toBeNull();
  });
  it('invalidates when a different wallet has the same address and chain', async () => {
    await connectWallet(); signedIn();
    const listener = vi.fn(); onAccountChange(listener);
    emit([wallet()]);
    expect(listener).toHaveBeenCalledWith(ADDRESS, true);
    expect(getSession()).toBeNull();
  });
  it('ignores balance/metadata updates and does not duplicate subscriptions on reconnect', async () => {
    await connectWallet(); signedIn();
    const listener = vi.fn(); onAccountChange(listener);
    emit([{ ...wallets[0], accounts: [{ address: ADDRESS, balance: { USDC: '1' } }] }]);
    await connectWallet();
    expect(getSession()).not.toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(api.state.select).toHaveBeenCalledOnce();
  });
  it('clears provider and session on empty accounts, and can reconnect from events', async () => {
    await connectWallet(); signedIn();
    const selected = wallets[0];
    emit([{ ...selected, accounts: [] }]);
    expect(getConnectedAccount()).toBeNull();
    expect(getSession()).toBeNull();
    expect(() => walletClientFor(ARC)).toThrow('connect a wallet');
    emit([selected]);
    expect(getConnectedAccount()?.address).toBe(ADDRESS);
  });
  it('disconnects through Onboard and removes listeners on reset', async () => {
    await connectWallet(); signedIn();
    const listener = vi.fn(); const stop = onAccountChange(listener);
    await disconnectWallet();
    expect(api.disconnectWallet).toHaveBeenCalledWith({ label: 'Injected wallet' });
    expect(listener).toHaveBeenCalledWith(null, true);
    expect(getConnectedAccount()).toBeNull();
    expect(getSession()).toBeNull();
    stop(); emit([wallet()]);
    expect(listener).toHaveBeenCalledTimes(1);
    resetWalletStateForTests();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('network switching and viem', () => {
  it.each([ARC, SEPOLIA])('uses Onboard to switch to $name and verifies the provider network', async config => {
    await connectWallet();
    await ensureChain(config.chainId, config);
    expect(api.setChain).toHaveBeenCalledWith({ wallet: 'Injected wallet', chainId: `0x${config.chainId.toString(16)}` });
    const client = walletClientFor(config);
    expect(client.chain?.id).toBe(config.chainId);
    expect(client.account?.address).toBe(ADDRESS);
    expect(await client.getChainId()).toBe(config.chainId);
  });
  it('rejects unsupported targets before prompting the wallet', async () => {
    await connectWallet();
    await expect(ensureChain(1, { chainId: 1 })).rejects.toThrow('unsupported chain');
    expect(api.setChain).not.toHaveBeenCalled();
  });
  it('rejects a cancelled network switch', async () => {
    await connectWallet(); api.setChain.mockResolvedValue(false);
    await expect(ensureChain(SEPOLIA.chainId, SEPOLIA)).rejects.toThrow('required network');
  });
  it('does not trust success when the provider remains on another network', async () => {
    await connectWallet();
    api.setChain.mockImplementation(async () => { emit([{ ...wallets[0], chains: [{ id: '0xaa36a7' }] }]); return true; });
    await expect(ensureChain(SEPOLIA.chainId, SEPOLIA)).rejects.toThrow('required network');
  });
  it('aborts if the account changes during a network switch', async () => {
    await connectWallet();
    api.setChain.mockImplementation(async () => { emit([wallet(OTHER, SEPOLIA.chainId)]); return true; });
    await expect(ensureChain(SEPOLIA.chainId, SEPOLIA)).rejects.toThrow('wallet changed');
  });
  it('prevents an old viem client from signing after a wallet change', async () => {
    await connectWallet();
    const client = walletClientFor(ARC);
    const provider = wallets[0].provider;
    emit([wallet(OTHER)]);
    await expect(client.signMessage({ message: 'stale' })).rejects.toThrow('wallet changed');
    expect(provider.request).not.toHaveBeenCalled();
  });
});
