import { ARC, SEPOLIA, registryAbi } from '@verdikt/sdk';
import { byReputation, loadMarketplace } from './marketplace.js';
import { formatNativeUsdc } from './format.js';
import { resolveProviderConsole } from './provider.js';
import { readRoute, withService, withView } from './router.js';
import { createSource } from './source.js';
import { connectWallet, ensureChain, getConnectedAccount, onAccountChange, walletClientFor } from './wallet.js';
import { getSession, signIn } from './session.js';
import './forms/sla-editor.js';
import './forms/bond.js';
import './forms/wizard.js';
import './lit-app.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
const app = /** @type {import('./lit-app.js').VerdiktApp} */ (document.createElement('verdikt-app'));
root.append(app);
// Vite injects the env; `import.meta.env` is not in the shared jsconfig's lib.
const env = /** @type {Record<string, string|undefined>} */ (/** @type {any} */ (import.meta).env ?? {});
const { mode, deps } = createSource(env);

const ARC_CHAIN_CONFIG = { chainId: ARC.chainId, name: 'Arc Testnet', rpcUrl: /** @type {string} */ (env.VITE_ARC_RPC_URL), nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 } };
const SEPOLIA_CHAIN_CONFIG = { chainId: SEPOLIA.chainId, name: 'Ethereum Sepolia', rpcUrl: /** @type {string} */ (env.VITE_SEPOLIA_RPC_URL) };

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
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const route = readRoute(new URL(location.href));
  app.mode = mode;
  app.route = route;
  app.marketplace = marketplace;
  if (route.view === 'provider' && mode === 'live') {
    app.updateComplete.then(() => mountProviderConsole(route));
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
  const sessionMatchesAccount = Boolean(account && session && session.address.toLowerCase() === account.address.toLowerCase());
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
        ensureSepolia: () => ensureChain(SEPOLIA.chainId, SEPOLIA_CHAIN_CONFIG),
        ensureArc: () => ensureChain(ARC.chainId, ARC_CHAIN_CONFIG),
        onDone: () => main()
      };
    } else {
      wizardMount.message = 'Service onboarding needs the subname registrar deployed — not yet live on this build.';
    }
  } else if (wizardMount) {
    wizardMount.message = account ? "Connect as this provider's own address to add a service." : 'Connect a wallet to add a service.';
  }
  if (!target) return;
  const slaMount = /** @type {import('./forms/sla-editor.js').VerdiktSlaEditor|null} */ (app.querySelector('#sla-editor-mount'));
  if (slaMount && sessionMatchesAccount && viewingOwnPage) {
    slaMount.message = '';
    slaMount.listing = target;
    slaMount.deps = {
      walletClientFor: () => walletClientFor(SEPOLIA_CHAIN_CONFIG),
      ensureSepolia: () => ensureChain(SEPOLIA.chainId, SEPOLIA_CHAIN_CONFIG)
    };
  } else if (slaMount) {
    slaMount.message = "Connect as this service's own provider to publish changes.";
  }
  const bondMount = /** @type {import('./forms/bond.js').VerdiktBondControls|null} */ (app.querySelector('#bond-controls-mount'));
  if (bondMount && sessionMatchesAccount && viewingOwnPage) {
    bondMount.message = '';
    bondMount.listing = target;
    bondMount.deps = {
      walletClientFor: () => walletClientFor(ARC_CHAIN_CONFIG),
      registryAddress: /** @type {string} */ (ARC.registry),
      depositAmount,
      formatNativeUsdc,
      ensureArc: () => ensureChain(ARC.chainId, ARC_CHAIN_CONFIG)
    };
  } else if (bondMount) {
    bondMount.message = "Connect as this service's own provider to manage its bond.";
  }
}

onAccountChange(() => draw());
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
app.addEventListener('wallet-connect', async () => {
  try {
    const account = await connectWallet();
    await signIn(SEPOLIA.chainId, {
      address: account.address,
      walletClient: /** @type {any} */ (walletClientFor(SEPOLIA_CHAIN_CONFIG)),
      domain: location.host,
      origin: location.origin
    });
    draw();
  } catch (error) {
    // The only place this surfaces; there is no toast system.
    console.error('sign-in failed:', /** @type {Error} */ (error).message);
  }
});

main();
