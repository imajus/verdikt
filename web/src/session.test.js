import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { clearSession, getSession, signIn } from './session.js';

const ACCOUNT = privateKeyToAccount('0x059c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690');

/** A localStorage-shaped in-memory stub — jsdom is not part of this project's test setup. */
function fakeLocalStorage() {
  /** @type {Map<string, string>} */
  const store = new Map();
  return {
    getItem: (/** @type {string} */ key) => store.get(key) ?? null,
    setItem: (/** @type {string} */ key, /** @type {string} */ value) => store.set(key, String(value)),
    removeItem: (/** @type {string} */ key) => store.delete(key)
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage());
});

afterEach(() => {
  clearSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signIn', () => {
  it('signs a SIWE message with the connected wallet and persists a session', async () => {
    const walletClient = { signMessage: vi.fn(async ({ message }) => ACCOUNT.signMessage({ message })) };
    const session = await signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example' });
    expect(session.address.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(getSession()?.address.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
  });
  it('rejects a signature from a different address than the one requested', async () => {
    const other = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
    const walletClient = { signMessage: vi.fn(async ({ message }) => other.signMessage({ message })) };
    await expect(
      signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example' })
    ).rejects.toThrow();
  });
});

describe('getSession', () => {
  it('returns null when nothing has signed in', () => {
    expect(getSession()).toBeNull();
  });
  it('returns null once the session has expired', async () => {
    vi.useFakeTimers();
    const walletClient = { signMessage: vi.fn(async ({ message }) => ACCOUNT.signMessage({ message })) };
    await signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example', ttlMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(getSession()).toBeNull();
    vi.useRealTimers();
  });
});

describe('clearSession', () => {
  it('drops a signed-in session', async () => {
    const walletClient = { signMessage: vi.fn(async ({ message }) => ACCOUNT.signMessage({ message })) };
    await signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example' });
    clearSession();
    expect(getSession()).toBeNull();
  });
});


describe('sign-in invalidation', () => {
  it('persists the chain that was signed', async () => {
    await signIn(5042002, { address: ACCOUNT.address, walletClient: ACCOUNT, domain: 'verdikt.example', origin: 'https://verdikt.example' });
    expect(getSession()?.chainId).toBe(5042002);
  });
  it('does not restore a session if a wallet event invalidates it while signing', async () => {
    const walletClient = { signMessage: async (/** @type {{ message: string }} */ { message }) => { clearSession(); return ACCOUNT.signMessage({ message }); } };
    await expect(signIn(11155111, { address: ACCOUNT.address, walletClient, domain: 'verdikt.example', origin: 'https://verdikt.example' })).rejects.toThrow('wallet changed');
    expect(getSession()).toBeNull();
  });
  it('checks the connection again before persisting a valid signature', async () => {
    await expect(signIn(11155111, { address: ACCOUNT.address, walletClient: ACCOUNT, domain: 'verdikt.example', origin: 'https://verdikt.example', isCurrent: () => false })).rejects.toThrow('wallet changed');
    expect(getSession()).toBeNull();
  });
});
