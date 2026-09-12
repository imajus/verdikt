import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise the application coordinator with inert view elements. Wallet and
// SIWE adapters have their own provider/signature tests; here we verify that
// their events revoke and restore the actual form dependencies, now split
// across the wizard on /register and the SLA/bond controls on /services/<slug>/manage.
const state = vi.hoisted(() => ({
  account: /** @type {any} */ (null), session: /** @type {any} */ (null),
  changed: /** @type {any} */ (null), signIn: vi.fn(), ensureChain: vi.fn(),
  connectWallet: vi.fn(), disconnectWallet: vi.fn(), restoreWallet: vi.fn()
}));
const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
vi.mock('@verdikt/sdk', () => ({ ARC: { chainId: 5042002, registry: 'registry' }, SEPOLIA: { chainId: 11155111, subnameRegistrar: 'registrar' }, registryAbi: [] }));
vi.mock('./wallet.js', () => ({
  getConnectedAccount: () => state.account,
  onAccountChange: (/** @type {Function} */ fn) => { state.changed = fn; },
  connectWallet: state.connectWallet,
  disconnectWallet: state.disconnectWallet,
  restoreWallet: state.restoreWallet,
  ensureChain: state.ensureChain,
  walletClientFor: vi.fn(() => ({}))
}));
vi.mock('./session.js', () => ({ getSession: () => state.session, signIn: state.signIn }));
vi.mock('./source.js', () => ({ createSource: () => ({ mode: 'live', deps: { registry: { client: { readContract: async () => 1n } } } }) }));
vi.mock('./marketplace.js', () => ({
  byReputation: () => 0,
  loadMarketplace: async () => ({
    services: [
      { provider: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', slug: 'weather' },
      { provider: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', slug: 'quotes' }
    ],
    stats: {}
  })
}));
vi.mock('./theme.js', () => ({ savedTheme: () => 'light', saveTheme: vi.fn() }));
vi.mock('./lit-app.js', () => ({}));
vi.mock('./forms/sla-editor.js', () => ({}));
vi.mock('./forms/bond.js', () => ({}));
vi.mock('./forms/wizard.js', () => ({}));
vi.mock('./forms/subscribe.js', () => ({}));
vi.mock('./forms/contact.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/styles/themes/default.css', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/button/button.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/button-group/button-group.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/dropdown/dropdown.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/divider/divider.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/input/input.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/textarea/textarea.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/tooltip/tooltip.js', () => ({}));

/** @type {any} */ let app;
/** @type {Record<string, any>} */ let controls;
/** @type {Map<string, Function>} */ let events;
/** @type {Map<string, Function>} */ let windowEvents;
/** @type {import('vitest').Mock} */ let pushState;
/** @type {import('vitest').Mock} */ let replaceState;
/** @type {import('vitest').Mock} */ let historyBack;
/** @type {import('vitest').Mock} */ let scrollTo;
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function authenticate() { state.session = { ...state.account, expiresAt: Date.now() + 60000 }; }
function change(address = OWNER, chainId = 11155111, identityChanged = true) {
  state.account = address ? { address, chainId } : null;
  if (identityChanged) state.session = null;
  state.changed(address || null, identityChanged);
}
// The stubbed history.pushState is a no-op, unlike the real browser API it
// replaces — it never moves location forward on its own. Move it explicitly
// before dispatching, the same way the real app's next syncRoute() would see
// it after a real pushState.
/** @param {string} path */
async function go(path) {
  vi.stubGlobal('location', new URL(`https://verdikt.example${path}`));
  events.get('navigate')?.({ detail: path });
  await settle();
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  state.account = { address: OWNER, chainId: 11155111 }; authenticate();
  state.signIn.mockImplementation(async () => authenticate());
  state.connectWallet.mockImplementation(async () => state.account);
  state.restoreWallet.mockResolvedValue(undefined);
  state.disconnectWallet.mockImplementation(async () => change(''));
  state.ensureChain.mockImplementation(async chainId => change(OWNER, chainId, false));
  controls = Object.fromEntries(['sla-editor-mount', 'bond-controls-mount', 'wizard-mount'].map(id => [id, {
    deps: null, listing: null, draft: 'draft', step: 2, restoreStep: vi.fn(),
    clear() { this.deps = null; this.listing = null; this.draft = ''; this.step = 1; }
  }]));
  events = new Map();
  windowEvents = new Map();
  app = { querySelector: (/** @type {string} */ selector) => controls[selector.slice(1)], updateComplete: Promise.resolve(), addEventListener: (/** @type {string} */ name, /** @type {Function} */ fn) => events.set(name, fn) };
  vi.stubGlobal('document', { getElementById: () => ({ append: vi.fn() }), createElement: () => app });
  vi.stubGlobal('location', new URL(`https://verdikt.example/?provider=${OWNER}`));
  pushState = vi.fn();
  replaceState = vi.fn();
  historyBack = vi.fn();
  scrollTo = vi.fn();
  vi.stubGlobal('history', { replaceState, pushState, back: historyBack });
  vi.stubGlobal('window', { addEventListener: (/** @type {string} */ name, /** @type {Function} */ listener) => windowEvents.set(name, listener), scrollTo });
  await import('./main.js'); await settle();
});
afterEach(() => vi.unstubAllGlobals());

it('mounts the wizard, not the sla/bond controls, on /register for the signed-in owner', async () => {
  await go('/register');
  expect(controls['wizard-mount'].deps.account).toBe(OWNER);
  // The wizard's own post-registration "view your service" link needs an
  // SPA-navigating go(), not a full reload — see main.js's shared go().
  expect(controls['wizard-mount'].deps.go).toBeTypeOf('function');
  expect(controls['sla-editor-mount'].deps).toBeNull();
  expect(controls['bond-controls-mount'].deps).toBeNull();
});
it('mounts the sla/bond controls, not the wizard, on the owner’s own manage page', async () => {
  await go('/services/weather/manage');
  expect(controls['sla-editor-mount'].deps).not.toBeNull();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
  expect(controls['wizard-mount'].deps).toBeNull();
});
it('mounts nothing on the service page itself, even for its owner', async () => {
  await go('/services/weather');
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('mounts nothing on a service owned by someone else', async () => {
  await go('/services/quotes');
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('mounts nothing on a service that does not exist', async () => {
  await go('/services/nonexistent');
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('mounts nothing on the provider console, a valid address or none', async () => {
  await go(`/provider/${OWNER}`);
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  await go('/provider');
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('starts wallet restoration on load without requesting connection or sign-in', () => {
  expect(state.restoreWallet).toHaveBeenCalledOnce();
  expect(state.connectWallet).not.toHaveBeenCalled();
  expect(state.signIn).not.toHaveBeenCalled();
});
it('immediately removes stale controls when a different account views the owner-only service page', async () => {
  await go('/services/weather/manage');
  change(OTHER);
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('resets the wizard’s step when a different account activates /register', async () => {
  await go('/register');
  change(OTHER);
  expect(controls['wizard-mount'].step).toBe(1);
});
it('revokes all provider controls on disconnect', async () => {
  await go('/services/weather/manage');
  await events.get('wallet-disconnect')?.(); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('suspends controls on an external chain change without losing drafts', async () => {
  await go('/services/weather/manage');
  change(OWNER, 1, false); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  expect(controls['sla-editor-mount'].draft).toBe('draft');
});
it('reuses authentication after switching to Arc and restores its dependencies', async () => {
  await go('/services/weather/manage');
  const ensureArc = controls['bond-controls-mount'].deps.ensureArc;
  await ensureArc();
  expect(state.ensureChain).toHaveBeenCalledWith(5042002, expect.objectContaining({ chainId: 5042002 }));
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
  // A same-identity chain switch nulls deps but never calls .clear() — the
  // wizard's own step (irrelevant to this page) is left exactly as it was.
  expect(controls['wizard-mount'].step).toBe(2);
});
it('does not restore controls when re-authentication is rejected', async () => {
  await go('/services/weather/manage');
  state.signIn.mockRejectedValueOnce(new Error('user rejected'));
  const ensureArc = controls['bond-controls-mount'].deps.ensureArc;
  state.session = null;
  await expect(ensureArc()).rejects.toThrow('user rejected'); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('connects on an unsupported network without requesting a signature or network switch', async () => {
  await go('/services/weather/manage');
  change(OWNER, 1, false); await settle();
  await events.get('wallet-connect')?.(); await settle();
  expect(state.ensureChain).not.toHaveBeenCalled();
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).toBeNull();
});
it('recovers from an unsupported network on explicit provider activation without re-signing', async () => {
  await go('/services/weather/manage');
  change(OWNER, 1, false); await settle();
  await events.get('provider-sign-in')?.(); await settle();
  expect(state.ensureChain).toHaveBeenCalledWith(11155111, expect.objectContaining({ chainId: 11155111 }));
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
});
it('requires an explicit provider sign-in after connecting without a saved session', async () => {
  await go('/services/weather/manage');
  change(); await settle();
  await events.get('wallet-connect')?.(); await settle();
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).toBeNull();
  await events.get('provider-sign-in')?.(); await settle();
  expect(state.signIn).toHaveBeenCalledOnce();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
});
it('reports a rejected provider sign-in without reconnecting or enabling actions', async () => {
  await go('/services/weather/manage');
  change(); await settle();
  state.signIn.mockRejectedValueOnce(new Error('user rejected'));
  await events.get('provider-sign-in')?.(); await settle();
  expect(app.signInError).toContain('not completed');
  expect(app.signInPending).toBe(false);
  expect(state.connectWallet).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).toBeNull();
});
it('rewrites a legacy ?provider= deep link to the canonical path on load', () => {
  expect(replaceState).toHaveBeenCalledWith(null, '', `/provider/${OWNER}`);
});
it('navigates to the provider console after an explicit wallet connect', async () => {
  await events.get('wallet-connect')?.(); await settle();
  expect(pushState).toHaveBeenCalledWith(null, '', `/provider/${OWNER}`);
});
it('does not push a redundant history entry when reconnecting the same provider wallet', async () => {
  vi.stubGlobal('location', new URL(`https://verdikt.example/provider/${OWNER}`));
  pushState.mockClear();
  await events.get('wallet-connect')?.(); await settle();
  expect(pushState).not.toHaveBeenCalled();
});
it('scrolls to the new page heading after Lit renders a forward navigation', async () => {
  events.get('navigate')?.({ detail: '/terms' });
  expect(scrollTo).not.toHaveBeenCalled();
  await settle();
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
});
// The wizard's four steps live under one URL, so without these hooks the
// browser's Back leaves /register entirely from step 3 rather than stepping
// back to step 2, discarding the slug, URL and SLA already typed.
it('gives the wizard the history hooks its steps move through', async () => {
  await go('/register');
  expect(controls['wizard-mount'].deps.pushStep).toBeTypeOf('function');
  expect(controls['wizard-mount'].deps.backStep).toBeTypeOf('function');
});
it('records a wizard step as a same-URL history entry', async () => {
  await go('/register');
  controls['wizard-mount'].deps.pushStep(3);
  expect(pushState).toHaveBeenCalledWith({ wizardStep: 3 }, '', location.href);
});
it('walks the wizard back through history rather than re-rendering it', async () => {
  await go('/register');
  controls['wizard-mount'].deps.backStep();
  expect(historyBack).toHaveBeenCalledOnce();
});
it('restores the wizard step recorded in a popped history entry', async () => {
  await go('/register');
  windowEvents.get('popstate')?.({ state: { wizardStep: 2 } });
  await settle();
  expect(controls['wizard-mount'].restoreStep).toHaveBeenCalledWith(2);
});
it('treats a history entry carrying no wizard step as step 1', async () => {
  await go('/register');
  windowEvents.get('popstate')?.({ state: null });
  await settle();
  expect(controls['wizard-mount'].restoreStep).toHaveBeenCalledWith(1);
});
it('leaves scroll restoration to the browser for back and forward history', async () => {
  windowEvents.get('popstate')?.({ state: null });
  await settle();
  expect(scrollTo).not.toHaveBeenCalled();
});
it('does not navigate to the provider console on a silent wallet restoration', async () => {
  change(OTHER);
  await settle();
  expect(pushState).not.toHaveBeenCalled();
});
