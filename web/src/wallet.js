// The only file that knows a browser wallet exists — same choke-point idiom
// as @verdikt/sdk/ens.js. Two chains (Sepolia for ENS writes, Arc for the
// registry) means every caller needs the same connect/switch-chain dance, and
// this is the one place it is written.
//
// EIP-6963 (`eip6963:announceProvider`) is preferred where a page supports
// multiple installed wallets; `window.ethereum` is the fallback every wallet
// still injects. No wallet-connection library: the whole surface here is
// "get an account, switch a chain, hear about changes" — three things viem's
// own `custom` transport and a dozen lines already cover.

import { createWalletClient, custom } from 'viem';

/** @type {{ address: string, chainId: number } | null} */
let connected = null;
/** @type {unknown} */
let activeProvider = null;
/** @type {Set<(address: string|null) => void>} */
const listeners = new Set();

/** Test-only: clears module state between tests. */
export function resetWalletStateForTests() {
  connected = null;
  activeProvider = null;
  listeners.clear();
}

/** @returns {unknown} */
function discoverProvider() {
  // EIP-6963 first: a page with multiple wallets gets whichever announced
  // itself most recently, which is closer to "the one the user just clicked"
  // than window.ethereum's single, overwritten-on-conflict slot.
  /** @type {unknown} */
  let found = /** @type {{ ethereum?: unknown }} */ (window).ethereum ?? null;
  const onAnnounce = (/** @type {CustomEvent} */ event) => {
    found = /** @type {{ provider: unknown }} */ (event.detail).provider;
  };
  window.addEventListener('eip6963:announceProvider', /** @type {EventListener} */ (onAnnounce));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  window.removeEventListener('eip6963:announceProvider', /** @type {EventListener} */ (onAnnounce));
  return found;
}

/**
 * @param {unknown} provider
 * @param {{ method: string, params?: unknown[] }} args
 */
const request = (provider, args) => /** @type {{ request: Function }} */ (provider).request(args);

/** @returns {Promise<{ address: string, chainId: number }>} */
export async function connectWallet() {
  const provider = discoverProvider();
  if (!provider) throw new Error('no wallet found — install one or connect through a browser extension');
  const accounts = /** @type {string[]} */ (await request(provider, { method: 'eth_requestAccounts' }));
  const chainIdHex = /** @type {string} */ (await request(provider, { method: 'eth_chainId' }));
  activeProvider = provider;
  connected = { address: accounts[0], chainId: Number.parseInt(chainIdHex, 16) };
  /** @type {{ on?: Function }} */ (provider).on?.('accountsChanged', (/** @type {string[]} */ next) => {
    if (next.length === 0) {
      connected = null;
    } else if (connected) {
      connected = { ...connected, address: next[0] };
    }
    for (const listener of listeners) listener(next.length > 0 ? next[0] : null);
  });
  /** @type {{ on?: Function }} */ (provider).on?.('chainChanged', (/** @type {string} */ hex) => {
    if (connected) connected = { ...connected, chainId: Number.parseInt(hex, 16) };
  });
  return connected;
}

/** @returns {{ address: string, chainId: number } | null} */
export function getConnectedAccount() {
  return connected;
}

/**
 * @param {(address: string|null) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Switches the connected wallet to `chainId`, adding it first if the wallet
 * has never seen it — neither Arc Testnet nor Sepolia's public RPC is a
 * default in most wallets.
 *
 * @param {number} chainId
 * @param {{ chainId: number, name: string, rpcUrl: string, nativeCurrency?: { name: string, symbol: string, decimals: number }, blockExplorerUrl?: string }} chainConfig
 */
export async function ensureChain(chainId, chainConfig) {
  if (!activeProvider) throw new Error('connect a wallet before switching chains');
  const hex = `0x${chainId.toString(16)}`;
  try {
    await request(activeProvider, { method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (error) {
    // 4902: the wallet has never heard of this chain — add it, then it can switch.
    if (/** @type {{ code?: number }} */ (error).code !== 4902) throw error;
    await request(activeProvider, {
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hex,
          chainName: chainConfig.name,
          rpcUrls: [chainConfig.rpcUrl],
          nativeCurrency: chainConfig.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: chainConfig.blockExplorerUrl ? [chainConfig.blockExplorerUrl] : undefined
        }
      ]
    });
  }
}

/**
 * A viem wallet client over the connected EIP-1193 provider, for `actions.js`
 * to send transactions through.
 *
 * @param {{ chainId: number, name: string, rpcUrl: string, nativeCurrency?: { name: string, symbol: string, decimals: number } }} chainConfig
 */
export function walletClientFor(chainConfig) {
  if (!activeProvider || !connected) throw new Error('connect a wallet first');
  return createWalletClient({
    account: /** @type {`0x${string}`} */ (connected.address),
    chain: {
      id: chainConfig.chainId,
      name: chainConfig.name,
      nativeCurrency: chainConfig.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [chainConfig.rpcUrl] } }
    },
    transport: custom(/** @type {any} */ (activeProvider))
  });
}
