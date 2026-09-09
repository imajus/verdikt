import { ARC, SEPOLIA, registryAbi } from '@verdikt/sdk';
import { byReputation, loadMarketplace } from './marketplace.js';
import { formatNativeUsdc } from './format.js';
import { renderApp, resolveProviderConsole } from './render.js';
import { readRoute, withService, withView } from './router.js';
import { createSource } from './source.js';
import { connectWallet, ensureChain, getConnectedAccount, onAccountChange, walletClientFor } from './wallet.js';
import { getSession, signIn } from './session.js';
import { mountSlaEditor } from './forms/sla-editor.js';
import { mountBondControls } from './forms/bond.js';
import { mountWizard } from './forms/wizard.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
// Vite injects the env; `import.meta.env` is not in the shared jsconfig's lib.
const { mode, deps } = createSource(/** @type {any} */ (import.meta).env ?? {});

const ARC_CHAIN_CONFIG = { chainId: ARC.chainId, name: 'Arc Testnet', rpcUrl: 'https://rpc.testnet.arc.network', nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 } };
const SEPOLIA_CHAIN_CONFIG = { chainId: SEPOLIA.chainId, name: 'Ethereum Sepolia', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' };

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
  root.innerHTML = '<p class="empty">Reading Arc and the naming layer…</p>';
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
    root.innerHTML = `<p class="note warn">Could not load the marketplace: ${/** @type {Error} */ (error).message}</p>`;
  }
}

function draw() {
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const route = readRoute(new URL(location.href));
  const selected = marketplace.services.find((listing) => listing.slug === route.service) ?? marketplace.services[0] ?? null;
  root.innerHTML = renderApp(marketplace, mode, route.view, selected?.slug ?? null, route.provider);
  for (const row of root.querySelectorAll('.row[data-slug]')) {
    row.addEventListener('click', () => {
      const slug = /** @type {HTMLElement} */ (row).dataset.slug ?? null;
      if (slug) {
        // Keeps a service's page linkable — the point of a marketplace is that
        // someone can send you the listing they are looking at.
        history.replaceState(null, '', withService(new URL(location.href), String(slug)));
        draw();
      }
    });
  }
  for (const link of root.querySelectorAll('.nav-item[data-nav]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = /** @type {HTMLElement} */ (link).dataset.nav ?? 'marketplace';
      history.replaceState(null, '', withView(new URL(location.href), target));
      draw();
    });
  }
  if (route.view === 'provider' && mode === 'live') {
    mountProviderConsole(route);
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
  const wizardMount = root.querySelector('#wizard-mount');
  if (wizardMount && account && sessionMatchesAccount && viewingOwnPage) {
    if (SEPOLIA.subnameRegistrar) {
      mountWizard(/** @type {HTMLElement} */ (wizardMount), {
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
      });
    } else {
      wizardMount.innerHTML = '<p class="aside">Service onboarding needs the subname registrar deployed — not yet live on this build.</p>';
    }
  } else if (wizardMount) {
    wizardMount.innerHTML = account
      ? '<p class="aside">Connect as this provider\'s own address to add a service.</p>'
      : '<p class="aside">Connect a wallet to add a service.</p>';
  }
  if (!target) return;
  const slaMount = root.querySelector('#sla-editor-mount');
  if (slaMount && sessionMatchesAccount && viewingOwnPage) {
    mountSlaEditor(/** @type {HTMLElement} */ (slaMount), target, {
      walletClientFor: () => walletClientFor(SEPOLIA_CHAIN_CONFIG),
      sepoliaChainConfig: SEPOLIA_CHAIN_CONFIG,
      ensureSepolia: () => ensureChain(SEPOLIA.chainId, SEPOLIA_CHAIN_CONFIG)
    });
  } else if (slaMount) {
    slaMount.innerHTML = '<p class="aside">Connect as this service\'s own provider to publish changes.</p>';
  }
  const bondMount = root.querySelector('#bond-controls-mount');
  if (bondMount && sessionMatchesAccount && viewingOwnPage) {
    mountBondControls(/** @type {HTMLElement} */ (bondMount), target, {
      walletClientFor: () => walletClientFor(ARC_CHAIN_CONFIG),
      registryAddress: /** @type {string} */ (ARC.registry),
      depositAmount,
      formatNativeUsdc,
      ensureArc: () => ensureChain(ARC.chainId, ARC_CHAIN_CONFIG)
    });
  } else if (bondMount) {
    bondMount.innerHTML = '<p class="aside">Connect as this service\'s own provider to manage its bond.</p>';
  }
}

onAccountChange(() => draw());

document.addEventListener('click', async (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.id !== 'connect-wallet') return;
  event.preventDefault();
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
