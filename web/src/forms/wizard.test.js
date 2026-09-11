import { describe, expect, it, vi } from 'vitest';
import { VerdiktWizard, buildExecutionSteps } from './wizard.js';

/** @returns {any} */
const deps = (overrides = {}) => ({
  account: '0xAccount', registrarAddress: '0xRegistrar', registryAddress: '0xRegistry',
  depositAmount: 50n * 10n ** 18n, sepoliaRpcUrl: 'https://sepolia.example',
  formatNativeUsdc: (/** @type {bigint} */ v) => `${v / 10n ** 18n} USDC`,
  walletClientFor: () => ({ writeContract: vi.fn(async () => '0xhash'), sendTransaction: vi.fn(async () => '0xhash') }),
  ensureSepolia: vi.fn(async () => {}), ensureArc: vi.fn(async () => {}), onDone: vi.fn(),
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
