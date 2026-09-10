// A client-side proof of address control — not an authorization boundary.
// Every provider write is its own wallet-signed transaction regardless of
// this session's state (web/src/actions.js); signing in only unlocks the
// write affordances in the UI and gives the page a "signed in as 0x…"
// identity to show. There is no backend here to protect: nothing server-side
// exists yet that this session would be presented to.

import { recoverMessageAddress } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';

const STORAGE_KEY = 'verdikt.session';
let revision = 0;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number} chainId
 * @param {{
 *   address: string,
 *   walletClient: { signMessage: (args: { account?: unknown, message: string }) => Promise<string> },
 *   domain: string,
 *   origin: string,
 *   isCurrent?: () => boolean,
 *   ttlMs?: number
 * }} options
 * @returns {Promise<{ address: string, chainId: number, expiresAt: number }>}
 */
export async function signIn(chainId, { address, walletClient, domain, origin, ttlMs = DEFAULT_TTL_MS, isCurrent = () => true }) {
  const startedAtRevision = revision;
  const nonce = generateSiweNonce();
  const issuedAt = new Date();
  const message = createSiweMessage({
    address: /** @type {`0x${string}`} */ (address),
    chainId,
    domain,
    nonce,
    issuedAt,
    statement: 'Sign in to Verdikt. This proves you control this address — it authorizes nothing by itself.',
    uri: origin,
    version: '1'
  });
  const signature = /** @type {`0x${string}`} */ (await walletClient.signMessage({ message }));
  const recovered = await recoverMessageAddress({ message, signature });
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error('the signature does not match the requested address');
  }
  const parsed = parseSiweMessage(message);
  const valid = validateSiweMessage({ address: /** @type {`0x${string}`} */ (address), domain, message: parsed, nonce, time: issuedAt });
  if (!valid) throw new Error('the signed SIWE message failed validation');
  if (revision !== startedAtRevision || !isCurrent()) throw new Error('wallet changed during sign-in — retry');
  const session = { address, chainId, expiresAt: issuedAt.getTime() + ttlMs };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

/** @returns {{ address: string, chainId: number, expiresAt: number } | null} */
export function getSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  /** @type {{ address: string, chainId: number, expiresAt: number }} */
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  // chainId records where the proof was signed. This browser-only identity
  // is reusable across supported networks; writes verify their own chain.
  if (!session || typeof session.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(session.address) || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return session;
}

export function clearSession() {
  revision++;
  localStorage.removeItem(STORAGE_KEY);
}
