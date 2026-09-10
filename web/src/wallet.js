// Web3-Onboard owns discovery, selection and wallet events. Transactions still
// use viem over the selected EIP-1193 provider.
import { createWalletClient, custom } from 'viem';
import { arcTestnet, sepolia } from 'viem/chains';
import { clearSession } from './session.js';

/** @type {{ address: string, chainId: number } | null} */
let connected = null;
/** @type {import('@web3-onboard/core').WalletState | null} */
let activeWallet = null;
/** @type {import('@web3-onboard/core').WalletState['provider'] | null} */
let activeProvider = null;
/** @type {Promise<import('@web3-onboard/core').OnboardAPI> | null} */
let onboardPromise = null;
/** @type {{ unsubscribe: () => void } | undefined} */
let subscription;
/** @type {Set<(address: string|null, identityChanged: boolean) => void>} */
const listeners = new Set();
let identityRevision = 0;

async function onboard() {
  if (!onboardPromise) {
    onboardPromise = (async () => {
      const [{ default: init }, { default: injected }] = await Promise.all([
        import('@web3-onboard/core'), import('@web3-onboard/injected-wallets')
      ]);
      const env = /** @type {Record<string, string|undefined>} */ (/** @type {any} */ (import.meta).env ?? {});
      const api = init({
        wallets: [injected()],
        chains: [arcTestnet, sepolia].map(chain => ({
          id: `0x${chain.id.toString(16)}`,
          token: chain.nativeCurrency.symbol,
          label: chain.name,
          rpcUrl: (chain.id === arcTestnet.id ? env.VITE_ARC_RPC_URL : env.VITE_SEPOLIA_RPC_URL) || chain.rpcUrls.default.http[0],
          blockExplorerUrl: chain.blockExplorers.default.url
        })),
        appMetadata: { name: 'Verdikt', description: 'Verified API marketplace' },
        connect: { autoConnectLastWallet: false },
        accountCenter: { desktop: { enabled: false }, mobile: { enabled: false } }
      });
      subscription = api.state.select('wallets').subscribe(syncWallets);
      return api;
    })().catch(error => { onboardPromise = null; throw error; });
  }
  return onboardPromise;
}

/** @param {import('@web3-onboard/core').WalletState[]} wallets */
function syncWallets(wallets) {
  const wallet = wallets[0];
  const address = wallet?.accounts[0]?.address;
  const chainId = Number(wallet?.chains[0]?.id);
  const next = address && Number.isSafeInteger(chainId) && chainId > 0 ? { address, chainId } : null;
  const provider = next ? wallet.provider : null;
  if (provider === activeProvider && next?.address.toLowerCase() === connected?.address.toLowerCase() && next?.chainId === connected?.chainId) return;
  const identityChanged = provider !== activeProvider || next?.address.toLowerCase() !== connected?.address.toLowerCase();
  if (identityChanged) identityRevision++;
  activeWallet = next ? wallet : null;
  activeProvider = provider;
  connected = next;
  clearSession();
  for (const listener of listeners) listener(connected?.address ?? null, identityChanged);
}

/** Test-only: dispose the Onboard subscription between tests. */
export function resetWalletStateForTests() {
  subscription?.unsubscribe();
  subscription = undefined;
  onboardPromise = null;
  connected = null;
  activeWallet = null;
  activeProvider = null;
  listeners.clear();
}

export async function connectWallet() {
  const api = await onboard();
  syncWallets(await api.connectWallet());
  if (!connected) throw new Error('no wallet selected');
  return connected;
}

export async function disconnectWallet() {
  if (!activeWallet) return;
  const api = await onboard();
  await api.disconnectWallet({ label: activeWallet.label });
  syncWallets(api.state.get().wallets);
}

export function getConnectedAccount() { return connected; }

/** Includes provider, account, chain changes and disconnects.
 * @param {(address: string|null, identityChanged: boolean) => void} fn
 */
export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @param {number} chainId
 * @param {{ chainId: number }} chainConfig
 */
export async function ensureChain(chainId, chainConfig) {
  if (!activeProvider || !connected || !activeWallet) throw new Error('connect a wallet before switching chains');
  if ((chainId !== arcTestnet.id && chainId !== sepolia.id) || chainId !== chainConfig.chainId) throw new Error('unsupported chain');
  const provider = activeProvider;
  const address = connected.address;
  const revision = identityRevision;
  const label = activeWallet.label;
  const api = await onboard();
  const success = await api.setChain({ chainId: `0x${chainId.toString(16)}`, wallet: label });
  syncWallets(api.state.get().wallets);
  if (revision !== identityRevision || provider !== activeProvider || address.toLowerCase() !== connected?.address.toLowerCase()) throw new Error('wallet changed — retry the action');
  const actualChainId = Number(await provider.request({ method: 'eth_chainId' }));
  if (revision !== identityRevision || provider !== activeProvider) throw new Error('wallet changed — retry the action');
  if (!success || connected?.chainId !== chainId || actualChainId !== chainId) throw new Error('switch to the required network first');
}

/**
 * A viem wallet client over the connected EIP-1193 provider, for `actions.js`
 * to send transactions through.
 *
 * @param {{ chainId: number, name: string, rpcUrl: string, nativeCurrency?: { name: string, symbol: string, decimals: number } }} chainConfig
 */
export function walletClientFor(chainConfig) {
  if (!activeProvider || !connected) throw new Error('connect a wallet first');
  if (connected.chainId !== chainConfig.chainId) throw new Error('switch to the required network first');
  const provider = activeProvider;
  const account = connected;
  return createWalletClient({
    account: /** @type {`0x${string}`} */ (connected.address),
    chain: {
      id: chainConfig.chainId,
      name: chainConfig.name,
      nativeCurrency: chainConfig.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [chainConfig.rpcUrl] } }
    },
    transport: custom({
      async request(args) {
        if (provider !== activeProvider || account !== connected) throw new Error('wallet changed — retry the action');
        return provider.request(args);
      }
    })
  });
}
