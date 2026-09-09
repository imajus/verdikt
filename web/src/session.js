// A client-side proof of address control — not an authorization boundary.
// Every provider write is its own wallet-signed transaction regardless of
// this session's state (web/src/actions.js); signing in only unlocks the
// write affordances in the UI and gives the page a "signed in as 0x…"
// identity to show. There is no backend here to protect: nothing server-side
// exists yet that this session would be presented to.

import { recoverMessageAddress } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';

const STORAGE_KEY = 'verdikt.session';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number} chainId
 * @param {{
 *   address: string,
 *   walletClient: { signMessage: (args: { account?: unknown, message: string }) => Promise<string> },
 *   domain: string,
 *   origin: string,
 *   ttlMs?: number
 * }} options
 * @returns {Promise<{ address: string, expiresAt: number }>}
 */
export async function signIn(chainId, { address, walletClient, domain, origin, ttlMs = DEFAULT_TTL_MS }) {
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
  const session = { address, expiresAt: issuedAt.getTime() + ttlMs };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

/** @returns {{ address: string, expiresAt: number } | null} */
export function getSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  /** @type {{ address: string, expiresAt: number }} */
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!session.expiresAt || session.expiresAt <= Date.now()) {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return session;
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}
