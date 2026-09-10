import { ARC, SEPOLIA, registryAbi } from '@verdikt/sdk';
import { byReputation, loadMarketplace } from './marketplace.js';
import { formatNativeUsdc } from './format.js';
import { resolveProviderConsole } from './provider.js';
import { readRoute, withService, withView } from './router.js';
import { createSource } from './source.js';
import { connectWallet, disconnectWallet, ensureChain, getConnectedAccount, onAccountChange, restoreWallet, walletClientFor } from './wallet.js';
import { getSession, signIn } from './session.js';
import { savedTheme, saveTheme } from './theme.js';
// Import tokens only. Web Awesome's all-in-one stylesheet also styles every
// native button, table, and heading, which would override the ledger UI.
import '@awesome.me/webawesome/dist/styles/themes/default.css';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import './forms/sla-editor.js';
import './forms/bond.js';
import './forms/wizard.js';
import './lit-app.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
const app = /** @type {import('./lit-app.js').VerdiktApp} */ (document.createElement('verdikt-app'));
root.append(app);
app.theme = savedTheme();
const env = import.meta.env ?? {};
const { mode, deps } = createSource(env);

const ARC_CHAIN_CONFIG = { chainId: ARC.chainId, name: 'Arc Testnet', rpcUrl: /** @type {string} */ (env.VITE_ARC_RPC_URL || 'https://rpc.testnet.arc.network'), nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 } };
const SEPOLIA_CHAIN_CONFIG = { chainId: SEPOLIA.chainId, name: 'Ethereum Sepolia', rpcUrl: /** @type {string} */ (env.VITE_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com') };

/** @type {Marketplace | null} */
let marketplaceCache = null;
/**
 * Read live from the registry rather than hardcoded: DEPOSIT_AMOUNT is a
 * constructor argument on VerdiktRegistry (contracts/src/VerdiktRegistry.sol),
 * not a fixed value, and a wizard that guessed it wrong would either
 * under-fund a registration (reverts: IncorrectDeposit) or over-charge a
 * provider by however much the guess was off.
 * @type {bigint | null}
 */
let depositAmountCache = null;

async function main() {
  app.error = null;
  app.marketplace = null;
  try {
    marketplaceCache = await loadMarketplace(deps);
    marketplaceCache.services.sort(byReputation);
    // Only meaningful in live mode — demo mode's registry stub exposes no
    // .client/.address (web/src/source.js), and the Provider tab is hidden
    // there anyway, so nothing ever reads depositAmountCache in demo mode.
    if (mode === 'live') {
      depositAmountCache = await /** @type {any} */ (deps.registry).client.readContract({
        address: /** @type {any} */ (deps.registry).address,
        abi: registryAbi,
        functionName: 'DEPOSIT_AMOUNT'
      });
    }
    draw();
  } catch (error) {
    app.marketplace = null;
    app.error = /** @type {Error} */ (error).message;
  }
}

function draw() {
  if (!marketplaceCache) return;
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const route = readRoute(new URL(location.href));
  // `verdikt-app` is patched asynchronously by Lit. Clear the currently
  // mounted controls before that patch removes them, otherwise a wallet that
  // owns no services can retain the prior provider's listing and dependencies.
  if (route.view === 'provider' && mode === 'live' && !resolveProviderConsole(marketplace.services, route.view, route.provider, getConnectedAccount()?.address ?? null).target) {
    clearProviderControls(false);
  }
  app.mode = mode;
  app.theme = savedTheme();
  app.route = route;
  app.marketplace = marketplace;
  if (route.view === 'provider' && mode === 'live') {
    app.updateComplete.then(() => mountProviderConsole(route));
  }
}

function clearProviderControls(reset = true) {
  const wizard = /** @type {import('./forms/wizard.js').VerdiktWizard|null} */ (app.querySelector('#wizard-mount'));
  if (wizard) {
    wizard.deps = null;
    if (reset) wizard.clear();
  }
  const slaMount = /** @type {import('./forms/sla-editor.js').VerdiktSlaEditor|null} */ (app.querySelector('#sla-editor-mount'));
  const bondMount = /** @type {import('./forms/bond.js').VerdiktBondControls|null} */ (app.querySelector('#bond-controls-mount'));
  if (reset) { slaMount?.clear(); bondMount?.clear(); }
  else {
    if (slaMount) slaMount.deps = null;
    if (bondMount) bondMount.deps = null;
  }
}

/**
 * @param {ReturnType<typeof readRoute>} route
 */
function mountProviderConsole(route) {
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const account = getConnectedAccount();
  const session = getSession();
  const { effectiveProvider, target } = resolveProviderConsole(marketplace.services, route.view, route.provider, account?.address ?? null);
  const viewingOwnPage = Boolean(account && effectiveProvider && account.address.toLowerCase() === effectiveProvider.toLowerCase());
  const sessionMatchesAccount = Boolean(account && session && session.address.toLowerCase() === account.address.toLowerCase() && [ARC.chainId, SEPOLIA.chainId].includes(account.chainId));
  // Set in main() before draw() is ever called in live mode — see the guard
  // in main() above. Not null here.
  const depositAmount = /** @type {bigint} */ (depositAmountCache);
  const wizardMount = /** @type {import('./forms/wizard.js').VerdiktWizard|null} */ (app.querySelector('#wizard-mount'));
  if (wizardMount && account && sessionMatchesAccount && viewingOwnPage) {
    if (SEPOLIA.subnameRegistrar) {
      wizardMount.message = '';
      wizardMount.deps = {
        account: account.address,
        registrarAddress: SEPOLIA.subnameRegistrar,
        registryAddress: /** @type {string} */ (ARC.registry),
        depositAmount,
        sepoliaRpcUrl: SEPOLIA_CHAIN_CONFIG.rpcUrl,
        formatNativeUsdc,
        walletClientFor: (chain) => walletClientFor(chain === 'arc' ? ARC_CHAIN_CONFIG : SEPOLIA_CHAIN_CONFIG),
        ensureSepolia: () => ensureSignedChain(SEPOLIA_CHAIN_CONFIG),
        ensureArc: () => ensureSignedChain(ARC_CHAIN_CONFIG),
        onDone: () => main()
      };
    } else {
      wizardMount.message = 'Service onboarding needs the subname registrar deployed — not yet live on this build.';
    }
  } else if (wizardMount) {
    wizardMount.deps = null;
    wizardMount.message = viewingOwnPage ? 'Sign in with this wallet to add a service.' : account ? "Connect as this provider's own address to add a service." : 'Connect a wallet to add a service.';
  }
  const slaMount = /** @type {import('./forms/sla-editor.js').VerdiktSlaEditor|null} */ (app.querySelector('#sla-editor-mount'));
  const bondMount = /** @type {import('./forms/bond.js').VerdiktBondControls|null} */ (app.querySelector('#bond-controls-mount'));
  // Defensive duplicate of the pre-render reset in draw(). It keeps this
  // invariant true if this mounting sequence is called independently later.
  if (!target) {
    slaMount?.clear();
    bondMount?.clear();
    return;
  }
  if (slaMount && sessionMatchesAccount && viewingOwnPage) {
    slaMount.message = '';
    slaMount.listing = target;
    slaMount.deps = {
      walletClientFor: () => walletClientFor(SEPOLIA_CHAIN_CONFIG),
      ensureSepolia: () => ensureSignedChain(SEPOLIA_CHAIN_CONFIG)
    };
  } else if (slaMount) {
    slaMount.deps = null;
    slaMount.message = viewingOwnPage ? 'Sign in with this wallet to publish changes.' : "Connect as this service's own provider to publish changes.";
  }
  if (bondMount && sessionMatchesAccount && viewingOwnPage) {
    bondMount.message = '';
    bondMount.listing = target;
    bondMount.deps = {
      walletClientFor: () => walletClientFor(ARC_CHAIN_CONFIG),
      registryAddress: /** @type {string} */ (ARC.registry),
      depositAmount,
      formatNativeUsdc,
      ensureArc: () => ensureSignedChain(ARC_CHAIN_CONFIG)
    };
  } else if (bondMount) {
    bondMount.deps = null;
    bondMount.message = viewingOwnPage ? 'Sign in with this wallet to manage its bond.' : "Connect as this service's own provider to manage its bond.";
  }
}

onAccountChange((_address, identityChanged) => {
  clearProviderControls(identityChanged);
  draw();
});

async function signInConnected() {
  const account = getConnectedAccount();
  if (!account) throw new Error('connect a wallet first');
  if (getSession()?.address.toLowerCase() === account.address.toLowerCase()) return;
  const config = account.chainId === ARC.chainId ? ARC_CHAIN_CONFIG : SEPOLIA_CHAIN_CONFIG;
  await signIn(account.chainId, {
    address: account.address,
    walletClient: /** @type {any} */ (walletClientFor(config)),
    domain: location.host,
    origin: location.origin,
    isCurrent: () => getConnectedAccount() === account
  });
}

/** @param {typeof ARC_CHAIN_CONFIG | typeof SEPOLIA_CHAIN_CONFIG} config */
async function ensureSignedChain(config) {
  await ensureChain(config.chainId, config);
  await signInConnected();
  draw();
  // Restore dependencies suspended by the chain-change event before the
  // pending provider action resumes, preserving its draft and wizard step.
  mountProviderConsole(readRoute(new URL(location.href)));
}
app.addEventListener('wallet-disconnect', async () => {
  try { await disconnectWallet(); }
  catch (error) { console.error('disconnect failed:', error); }
});
app.addEventListener('service-select', (event) => {
  const slug = /** @type {CustomEvent<string>} */ (event).detail;
  history.replaceState(null, '', withService(new URL(location.href), slug));
  draw();
});
app.addEventListener('view-select', (event) => {
  const view = /** @type {CustomEvent<string>} */ (event).detail;
  history.replaceState(null, '', withView(new URL(location.href), view));
  draw();
});
app.addEventListener('theme-select', (event) => {
  saveTheme(/** @type {CustomEvent<'light'|'dark'>} */ (event).detail);
  app.theme = savedTheme();
});
app.addEventListener('wallet-connect', async () => {
  try {
    await connectWallet();
    draw();
  } catch (error) {
    console.error('connection failed:', /** @type {Error} */ (error).message);
  }
});
app.addEventListener('provider-sign-in', async () => {
  if (app.signInPending) return;
  app.signInPending = true;
  app.signInError = null;
  try {
    const account = getConnectedAccount();
    const route = readRoute(new URL(location.href));
    if (!account || (route.provider && route.provider.toLowerCase() !== account.address.toLowerCase())) throw new Error('Connect your provider wallet first.');
    if (account && ![ARC.chainId, SEPOLIA.chainId].includes(account.chainId)) {
      await ensureChain(SEPOLIA.chainId, SEPOLIA_CHAIN_CONFIG);
    }
    await signInConnected();
    draw();
  } catch {
    app.signInError = 'Sign-in was not completed. You can try again when you’re ready.';
  } finally {
    app.signInPending = false;
  }
});

main();
if (mode === 'live') {
  restoreWallet().catch(error => console.warn('wallet restoration failed:', error));
}
