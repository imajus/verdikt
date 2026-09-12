// Shared plumbing for the sweep scripts.
//
// These run as one-off CLI tools from a terminal, not inside the app, so they
// cannot assume the environment a Worker or `pnpm dev` would have set up. The
// two things they each need — the root `.env` and the repo root itself — are
// resolved here so neither script has to care where it was invoked from.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, from this file's own location rather than `process.cwd()`. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Load the root `.env` into `process.env` without clobbering anything already
 * set, so an explicit `ARC_RPC_URL=… node script.mjs` still wins.
 *
 * The repo has no dotenv dependency and `packages/sdk/env.js` only reads
 * `process.env`, which is why every earlier run of this workflow had to be
 * prefixed with `set -a && source .env`. Forgetting that prefix does not fail
 * loudly — it silently falls back to Arc's public RPC, which rate-limits
 * `eth_getLogs` partway through a scan. Doing it here removes the footgun.
 */
export function loadEnv() {
  let text;
  try {
    text = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return; // No .env is fine — the SDK falls back to Arc's public RPC.
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.trim().replace(/^["']|["']$/g, '');
  }
}

/** @param {unknown} value */
export const json = (value) =>
  JSON.stringify(value, (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner), 2);
