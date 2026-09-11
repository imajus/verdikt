import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise the application coordinator with inert view elements. Wallet and
// SIWE adapters have their own provider/signature tests; here we verify that
// their events revoke and restore the actual form dependencies.
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
vi.mock('./marketplace.js', () => ({ byReputation: () => 0, loadMarketplace: async () => ({ services: [{ provider: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', slug: 'weather' }], stats: {} }) }));
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

/** @type {any} */ let app;
/** @type {Record<string, any>} */ let controls;
/** @type {Map<string, Function>} */ let events;
/** @type {import('vitest').Mock} */ let pushState;
/** @type {import('vitest').Mock} */ let replaceState;
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function authenticate() { state.session = { ...state.account, expiresAt: Date.now() + 60000 }; }
function change(address = OWNER, chainId = 11155111, identityChanged = true) {
  state.account = address ? { address, chainId } : null;
  if (identityChanged) state.session = null;
  state.changed(address || null, identityChanged);
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
    deps: null, listing: null, draft: 'draft', step: 2,
    clear() { this.deps = null; this.listing = null; this.draft = ''; this.step = 1; }
  }]));
  events = new Map();
  app = { querySelector: (/** @type {string} */ selector) => controls[selector.slice(1)], updateComplete: Promise.resolve(), addEventListener: (/** @type {string} */ name, /** @type {Function} */ fn) => events.set(name, fn) };
  vi.stubGlobal('document', { getElementById: () => ({ append: vi.fn() }), createElement: () => app });
  vi.stubGlobal('location', new URL(`https://verdikt.example/?provider=${OWNER}`));
  pushState = vi.fn();
  replaceState = vi.fn();
  vi.stubGlobal('history', { replaceState, pushState });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  await import('./main.js'); await settle();
});
afterEach(() => vi.unstubAllGlobals());

it('mounts provider actions only for the signed-in owner', () => {
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
  expect(controls['sla-editor-mount'].deps).not.toBeNull();
  expect(controls['wizard-mount'].deps.account).toBe(OWNER);
});
it('starts wallet restoration on load without requesting connection or sign-in', () => {
  expect(state.restoreWallet).toHaveBeenCalledOnce();
  expect(state.connectWallet).not.toHaveBeenCalled();
  expect(state.signIn).not.toHaveBeenCalled();
});
it('immediately removes stale controls when a different account views an explicit provider URL', async () => {
  change(OTHER);
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  expect(controls['wizard-mount'].step).toBe(1);
});
it('revokes all provider controls on disconnect', async () => {
  await events.get('wallet-disconnect')?.(); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('suspends controls on an external chain change without losing drafts', async () => {
  change(OWNER, 1, false); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  expect(controls['sla-editor-mount'].draft).toBe('draft');
});
it('reuses authentication after switching to Arc and restores its dependencies', async () => {
  const ensureArc = controls['bond-controls-mount'].deps.ensureArc;
  await ensureArc();
  expect(state.ensureChain).toHaveBeenCalledWith(5042002, expect.objectContaining({ chainId: 5042002 }));
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
  expect(controls['wizard-mount'].step).toBe(2);
});
it('does not restore controls when re-authentication is rejected', async () => {
  state.signIn.mockRejectedValueOnce(new Error('user rejected'));
  const ensureArc = controls['bond-controls-mount'].deps.ensureArc;
  state.session = null;
  await expect(ensureArc()).rejects.toThrow('user rejected'); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('connects on an unsupported network without requesting a signature or network switch', async () => {
  change(OWNER, 1, false); await settle();
  await events.get('wallet-connect')?.(); await settle();
  expect(state.ensureChain).not.toHaveBeenCalled();
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).toBeNull();
});
it('recovers from an unsupported network on explicit provider activation without re-signing', async () => {
  change(OWNER, 1, false); await settle();
  await events.get('provider-sign-in')?.(); await settle();
  expect(state.ensureChain).toHaveBeenCalledWith(11155111, expect.objectContaining({ chainId: 11155111 }));
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
});
it('requires an explicit provider sign-in after connecting without a saved session', async () => {
  change(); await settle();
  await events.get('wallet-connect')?.(); await settle();
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).toBeNull();
  await events.get('provider-sign-in')?.(); await settle();
  expect(state.signIn).toHaveBeenCalledOnce();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
});
it('reports a rejected provider sign-in without reconnecting or enabling actions', async () => {
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
  // Update location to reflect the canonical path that syncRoute would have rewritten to
  vi.stubGlobal('location', new URL(`https://verdikt.example/provider/${OWNER}`));
  pushState.mockClear();
  await events.get('wallet-connect')?.(); await settle();
  expect(pushState).not.toHaveBeenCalled();
});
it('does not navigate to the provider console on a silent wallet restoration', async () => {
  change(OTHER);
  await settle();
  expect(pushState).not.toHaveBeenCalled();
});
