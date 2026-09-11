import { describe, expect, it, vi } from 'vitest';
import { render as renderToIterable } from '@lit-labs/ssr';
import { resolveServiceRecord } from '@verdikt/sdk';
import { VerdiktWizard, buildExecutionSteps } from './wizard.js';

/** @param {unknown} template */
const stringify = (template) => Array.from(renderToIterable(template)).join('');

vi.mock('@verdikt/sdk', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveServiceRecord: vi.fn(async () => ({ owner: null }))
}));

/** @returns {any} */
const deps = (overrides = {}) => ({
  account: '0xAccount', registrarAddress: '0xRegistrar', registryAddress: '0xRegistry',
  depositAmount: 50n * 10n ** 18n, sepoliaRpcUrl: 'https://sepolia.example',
  formatNativeUsdc: (/** @type {bigint} */ v) => `${v / 10n ** 18n} USDC`,
  walletClientFor: () => ({ writeContract: vi.fn(async () => '0xhash'), sendTransaction: vi.fn(async () => '0xhash') }),
  ensureSepolia: vi.fn(async () => {}), ensureArc: vi.fn(async () => {}), onDone: vi.fn(), go: vi.fn(),
  pushStep: vi.fn(), backStep: vi.fn(),
  ...overrides
});

describe('buildExecutionSteps', () => {
  it('orders claim before register before url before sla', () => {
    const steps = buildExecutionSteps(deps(), { slug: 'weather', url: 'https://x.example', sla: '{}' });
    expect(steps.map((s) => s.key)).toEqual(['claim', 'register', 'url', 'sla']);
  });
  it('routes claim and register to the chains the transactions actually land on', () => {
    const steps = buildExecutionSteps(deps(), { slug: 'weather', url: 'https://x.example', sla: '{}' });
    expect(steps.map((s) => s.chain)).toEqual(['Sepolia', 'Arc', 'Sepolia', 'Sepolia']);
  });
  it('names the bond amount in the register step’s label', () => {
    const steps = buildExecutionSteps(deps(), { slug: 'weather', url: 'https://x.example', sla: '{}' });
    expect(steps[1].label).toContain('50');
  });
  it('sends the trimmed url and sla, not the raw draft', async () => {
    const sendTransaction = vi.fn(async () => '0xhash');
    const walletClientFor = () => ({ writeContract: vi.fn(async () => '0xhash'), sendTransaction });
    const steps = buildExecutionSteps(deps({ walletClientFor }), { slug: 'weather', url: '  https://x.example  ', sla: '  {}  ' });
    await steps[2].run();
    await steps[3].run();
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });
});

// Instantiated directly rather than via document.createElement — the vitest
// environment here is plain Node (importing @lit-labs/ssr installs a global
// customElements shim, but not `document`), the same reason render.js's
// renderApp() does `new VerdiktApp()`. Only the element's own logic is under
// test, never its rendered output, so no DOM is needed.
describe('the wizard element', () => {
  /** @returns {any} */
  const mount = () => new VerdiktWizard();

  it('starts on step 1 with the deposit and no wallet activity', () => {
    const el = mount();
    expect(el.step).toBe(1);
    expect(el.done).toBe(0);
  });

  it('debounces rapid keystrokes into a single availability lookup', async () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      el.deps = deps();
      const type = (/** @type {string} */ value) => el.editSlug(/** @type {any} */ ({ currentTarget: { value } }));
      for (const value of ['w', 'we', 'wea', 'weat', 'weath', 'weathe', 'weather']) type(value);
      expect(resolveServiceRecord).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      expect(resolveServiceRecord).toHaveBeenCalledTimes(1);
      expect(resolveServiceRecord).toHaveBeenCalledWith('weather', expect.anything());
    } finally {
      vi.useRealTimers();
      vi.mocked(resolveServiceRecord).mockClear();
    }
  });

  it('never applies a stale lookup once the slug has moved on', async () => {
    vi.useFakeTimers();
    try {
      const el = mount();
      el.deps = deps();
      el.editSlug(/** @type {any} */ ({ currentTarget: { value: 'weather' } }));
      await vi.advanceTimersByTimeAsync(400);
      expect(el.availability).toBe('Available.');
      el.editSlug(/** @type {any} */ ({ currentTarget: { value: 'quotes' } }));
      expect(el.availability).toBe('Checking…');
      expect(el.available).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.mocked(resolveServiceRecord).mockClear();
    }
  });

  it('runs the four steps in order and reports done', async () => {
    const claim = vi.fn(async () => '0xhash');
    const publish = vi.fn(async () => '0xhash');
    const el = mount();
    el.deps = deps({ walletClientFor: () => ({ writeContract: claim, sendTransaction: publish }) });
    el.slug = 'weather'; el.available = true; el.url = 'https://x.example'; el.sla = '{}';
    el.step = 4;
    await el.execute();
    expect(el.done).toBe(4);
    expect(el.status).toBe('Done.');
    expect(el.deps.onDone).toHaveBeenCalledOnce();
  });

  it('records each forward step in browser history', () => {
    const el = mount();
    el.deps = deps();
    el.goStep(2);
    expect(el.step).toBe(2);
    expect(el.deps.pushStep).toHaveBeenCalledWith(2);
  });

  // In-page Back walks the history the forward steps built, rather than
  // pushing a third entry — otherwise the browser's own Back would then
  // replay the step the user just left.
  it('walks back through history rather than pushing a new entry', () => {
    const el = mount();
    el.deps = deps();
    el.step = 3;
    el.stepBack();
    expect(el.deps.backStep).toHaveBeenCalledOnce();
    expect(el.deps.pushStep).not.toHaveBeenCalled();
  });

  it('restores a step recorded in history', () => {
    const el = mount();
    el.deps = deps();
    el.slug = 'weather';
    el.step = 3;
    el.restoreStep(2);
    expect(el.step).toBe(2);
  });

  it('refuses to restore a step once a transaction has landed', () => {
    const el = mount();
    el.deps = deps();
    el.slug = 'weather'; el.step = 4; el.done = 2;
    el.restoreStep(1);
    expect(el.step).toBe(4);
  });

  // Navigating away from /register and back recreates the element: its
  // history entry still says "step 3", but the draft that step described is
  // gone, so a review of an empty form is not what to restore to.
  it('refuses to restore a later step into an empty wizard', () => {
    const el = mount();
    el.deps = deps();
    el.restoreStep(3);
    expect(el.step).toBe(1);
  });

  // Retry resumes from the step that failed, so which step that was has to
  // survive on screen — it is no longer carried by a per-step list.
  it('keeps naming the failed step alongside the failure', async () => {
    const register = vi.fn(async () => { throw new Error('user rejected'); });
    const el = mount();
    el.deps = deps({ walletClientFor: (/** @type {string} */ chain) => (chain === 'arc' ? { writeContract: register } : { writeContract: vi.fn(async () => '0xhash'), sendTransaction: vi.fn(async () => '0xhash') }) });
    el.slug = 'weather'; el.available = true; el.url = 'https://x.example'; el.sla = '{}';
    el.step = 4;
    await el.execute();
    expect(el.status).toContain('2/4');
    expect(el.status).toContain('Register on Arc');
    const html = stringify(el.render());
    expect(html).toContain('2/4');
    expect(html).toContain('user rejected');
  });

  it('offers a link to the new service once registration finishes', async () => {
    const el = mount();
    el.deps = deps({ walletClientFor: () => ({ writeContract: vi.fn(async () => '0xhash'), sendTransaction: vi.fn(async () => '0xhash') }) });
    el.slug = 'weather'; el.available = true; el.url = 'https://x.example'; el.sla = '{}';
    el.step = 4;
    await el.execute();
    const html = stringify(el.render());
    expect(html).toContain('href="/services/weather"');
    expect(html).toContain('View your service');
  });

  it('does not offer the service link before registration finishes', () => {
    const el = mount();
    el.deps = deps();
    el.slug = 'weather'; el.available = true; el.url = 'https://x.example'; el.sla = '{}';
    el.step = 4;
    const html = stringify(el.render());
    expect(html).not.toContain('View your service');
  });

  it('parks the cursor on a failed step and resumes from it on retry, never re-claiming', async () => {
    const claim = vi.fn(async () => '0xhash');
    let registerCalls = 0;
    const register = vi.fn(async () => { registerCalls++; if (registerCalls === 1) throw new Error('user rejected'); return '0xhash'; });
    const el = mount();
    el.deps = deps({ walletClientFor: (/** @type {string} */ chain) => (chain === 'arc' ? { writeContract: register } : { writeContract: claim, sendTransaction: vi.fn(async () => '0xhash') }) });
    el.slug = 'weather'; el.available = true; el.url = 'https://x.example'; el.sla = '{}';
    el.step = 4;
    await el.execute();
    expect(el.done).toBe(1);
    expect(el.execError).toContain('user rejected');
    expect(claim).toHaveBeenCalledTimes(1);
    await el.execute();
    expect(el.done).toBe(4);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
