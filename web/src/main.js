import { ARC, SEPOLIA, registryAbi } from '@verdikt/sdk';
import { loadMarketplace } from './marketplace.js';
import { formatNativeUsdc } from './format.js';
import { parseRoute, providerUrl, titleFor } from './router.js';
import { createSource } from './source.js';
import { connectWallet, disconnectWallet, ensureChain, getConnectedAccount, onAccountChange, restoreWallet, walletClientFor } from './wallet.js';
import { getSession, signIn } from './session.js';
import { applyTheme, effectiveTheme, savePreference, savedPreference, watchSystemTheme } from './theme.js';
// Import tokens only. Web Awesome's all-in-one stylesheet also styles every
// native button, table, and heading, which would override the ledger UI.
import '@awesome.me/webawesome/dist/styles/themes/default.css';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import './forms/sla-editor.js';
import './forms/bond.js';
import './forms/wizard.js';
import './forms/subscribe.js';
import './forms/contact.js';
import './lit-app.js';

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
const app = /** @type {import('./lit-app.js').VerdiktApp} */ (document.createElement('verdikt-app'));
root.append(app);
syncTheme();
const env = import.meta.env ?? {};
const { mode, deps } = createSource(env);
// Set before main() resolves, not just in draw(), so the nav's wallet button
// is present in the loading skeleton rather than appearing once data lands.
app.mode = mode;
// Same reasoning, for the route: a direct load of e.g. /marketplace must not
// flash the landing page's default route while loadMarketplace() is still
// in flight.
app.route = syncRoute();

const ARC_CHAIN_CONFIG = { chainId: ARC.chainId, name: 'Arc Testnet', rpcUrl: /** @type {string} */ (env.VITE_ARC_RPC_URL || 'https://rpc.testnet.arc.network'), nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 } };
const SEPOLIA_CHAIN_CONFIG = { chainId: SEPOLIA.chainId, name: 'Ethereum Sepolia', rpcUrl: /** @type {string} */ (env.VITE_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com') };

/** @type {Marketplace | null} */
let marketplaceCache = null;
/**
 * Only meaningful in live mode — demo mode's registry stub exposes no
 * .client/.address (web/src/source.js), and the Provider tab is hidden
 * there anyway, so nothing ever reads depositAmountCache in demo mode.
 * @type {bigint | null}
 */
let depositAmountCache = null;

/**
 * The one place the URL is read and, if it isn't canonical (a legacy
 * `?provider=` link, an old bookmark), rewritten. `parseRoute` (router.js)
 * decides what canonical means; this is the side-effecting caller its own
 * file comment describes.
 */
function syncRoute() {
  const url = new URL(location.href);
  const route = parseRoute(url);
  if (route.canonicalPath !== url.pathname + url.search) history.replaceState(null, '', route.canonicalPath);
  document.title = titleFor(route);
  return route;
}

async function main() {
  app.error = null;
  app.marketplace = null;
  try {
    marketplaceCache = await loadMarketplace(deps);
    // Sorting used to happen once here, before the view ever saw the list.
    // It is now reactive view state (VerdiktApp.marketSort in lit-app.js) so
    // the marketplace's sort/filter controls can actually change the
    // displayed order (issue #64) — the array `loadMarketplace` returned is
    // kept in whatever order the registry read it in.
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

function syncTheme() {
  const preference = savedPreference();
  applyTheme(effectiveTheme(preference));
  app.theme = preference;
}

/** @param {{ scrollToTop?: boolean }} [options] */
function draw(options = {}) {
  const route = syncRoute();
  app.mode = mode;
  syncTheme();
  app.route = route;
  if (!marketplaceCache) return;
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const managesControls = mode === 'live' && (route.view === 'manage' || route.view === 'register');
  // `verdikt-app` is patched asynchronously by Lit. Clear the currently
  // mounted controls before that patch removes them, otherwise a wallet that
  // owns no services — or one looking at somebody else's service, where the
  // controls are not rendered at all — can retain the prior provider's
  // listing and dependencies.
  if (managesControls) {
    const { canWrite, target } = providerAuthorization(marketplace, route);
    if (!canWrite || (route.view === 'manage' && !target)) clearProviderControls(false);
  }
  app.marketplace = marketplace;
  if (managesControls) {
    app.updateComplete.then(() => mountProviderConsole(route));
  }
  // History navigation owns restoration for popstate. Only a newly pushed
  // route starts at its heading, and only once Lit has put that heading in DOM.
  if (options.scrollToTop) app.updateComplete.then(() => window.scrollTo(0, 0));
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
 * Whether the connected wallet may write on the console currently on screen,
 * and which listing its controls act on. This is the mount-side half of
 * `writeAuthorization` in lit-app.js — the two must agree, or a section
 * renders without a mount behind it (a dead control) or a mount appears with
 * no section around it (an invisible one). `target` only exists on a
 * `manage` route: `register` acts on the connected wallet directly, and the
 * service page and the provider console mount nothing at all.
 * @param {Marketplace} marketplace
 * @param {ReturnType<typeof parseRoute>} route
 */
function providerAuthorization(marketplace, route) {
  const account = getConnectedAccount();
  const session = getSession();
  const target = route.view === 'manage' ? marketplace.services.find((listing) => listing.slug === route.slug) ?? null : null;
  const providerAddress = route.view === 'manage' ? (target?.provider ?? null) : (account?.address ?? null);
  const ownPage = Boolean(account && providerAddress && account.address.toLowerCase() === providerAddress.toLowerCase());
  const sessionMatchesAccount = Boolean(account && session && session.address.toLowerCase() === account.address.toLowerCase() && [ARC.chainId, SEPOLIA.chainId].includes(account.chainId));
  return { account, target, canWrite: ownPage && sessionMatchesAccount };
}

/**
 * @param {ReturnType<typeof parseRoute>} route
 */
function mountProviderConsole(route) {
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const { account, target, canWrite } = providerAuthorization(marketplace, route);
  // Set in main() before draw() is ever called in live mode — see the guard
  // in main() above. Not null here.
  const depositAmount = /** @type {bigint} */ (depositAmountCache);
  const wizardMount = /** @type {import('./forms/wizard.js').VerdiktWizard|null} */ (app.querySelector('#wizard-mount'));
  if (wizardMount) {
    if (route.view === 'register' && account && canWrite) {
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
          onDone: () => main(),
          go,
          // The wizard's steps share /register's URL, so a step is a history
          // entry at the same path — not a route. Its own restoreStep()
          // decides whether a popped entry may be applied.
          pushStep: (step) => history.pushState({ wizardStep: step }, '', location.href),
          backStep: () => history.back()
        };
      } else {
        // A build-configuration fact, not an authorization one: this renders
        // on a page whose owner is signed in and may otherwise write.
        wizardMount.message = 'Service onboarding needs the subname registrar deployed — not yet live on this build.';
      }
    } else {
      wizardMount.deps = null;
    }
  }
  const slaMount = /** @type {import('./forms/sla-editor.js').VerdiktSlaEditor|null} */ (app.querySelector('#sla-editor-mount'));
  const bondMount = /** @type {import('./forms/bond.js').VerdiktBondControls|null} */ (app.querySelector('#bond-controls-mount'));
  // Off the manage route, or a manage route with no resolved listing (a
  // slug nobody owns), there is nothing for these two to act on — clear
  // rather than merely null, which also drops a stale draft.
  if (route.view !== 'manage' || !target) {
    slaMount?.clear();
    bondMount?.clear();
    return;
  }
  if (slaMount && canWrite) {
    slaMount.message = '';
    slaMount.listing = target;
    slaMount.deps = {
      walletClientFor: () => walletClientFor(SEPOLIA_CHAIN_CONFIG),
      ensureSepolia: () => ensureSignedChain(SEPOLIA_CHAIN_CONFIG)
    };
  } else if (slaMount) {
    slaMount.deps = null;
  }
  if (bondMount && canWrite) {
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
  mountProviderConsole(parseRoute(new URL(location.href)));
}
app.addEventListener('wallet-disconnect', async () => {
  try { await disconnectWallet(); }
  catch (error) { console.error('disconnect failed:', error); }
});
// Shared by the app's own 'navigate' event and anything mounted outside
// <verdikt-app> that still needs an SPA transition rather than a full
// reload — the wizard's post-registration "view your service" link.
/** @param {string} path */
function go(path) {
  const changed = path !== location.pathname + location.search;
  if (changed) history.pushState(null, '', path);
  draw({ scrollToTop: changed });
}
app.addEventListener('navigate', (event) => go(/** @type {CustomEvent<string>} */ (event).detail));
app.addEventListener('theme-select', (event) => {
  savePreference(/** @type {CustomEvent<'system'|'light'|'dark'>} */ (event).detail);
  syncTheme();
});
watchSystemTheme(() => {
  if (savedPreference() === 'system') syncTheme();
});
app.addEventListener('wallet-connect', async () => {
  try {
    const account = await connectWallet();
    // Connecting a wallet in this dashboard has no purpose today other than
    // provider self-management, so an explicit connect always lands there —
    // unlike the silent auto-reconnect below, which never fires this handler.
    const targetPath = providerUrl(account.address);
    if (targetPath !== location.pathname + location.search) history.pushState(null, '', targetPath);
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
    const route = parseRoute(new URL(location.href));
    if (!account || (route.address && route.address.toLowerCase() !== account.address.toLowerCase())) throw new Error('Connect your provider wallet first.');
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

window.addEventListener('popstate', (event) => {
  draw();
  // A popped entry may carry a wizard step (pushStep above). Same-URL
  // entries leave the mounted wizard in place, so this reaches the element
  // holding the draft; entries from another route have no wizard to restore.
  const wizard = /** @type {import('./forms/wizard.js').VerdiktWizard|null} */ (app.querySelector('#wizard-mount'));
  wizard?.restoreStep(/** @type {PopStateEvent} */ (event).state?.wizardStep ?? 1);
});

main();
if (mode === 'live') {
  restoreWallet().catch(error => console.warn('wallet restoration failed:', error));
}
