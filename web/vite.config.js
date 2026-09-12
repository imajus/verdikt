import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

// Mirrors the fallback RPC endpoints main.js/wallet.js fall back to when
// VITE_ARC_RPC_URL/VITE_SEPOLIA_RPC_URL are unset — a build with no custom
// RPC configured still reaches these, so connect-src has to allow them too.
const ARC_RPC_DEFAULT = 'https://rpc.testnet.arc.network';
const SEPOLIA_RPC_DEFAULT = 'https://ethereum-sepolia-rpc.publicnode.com';

/** @param {string|undefined} url */
function originOf(url) {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

// The dashboard's one inline script — the theme-flash guard in index.html —
// has to be allow-listed by hash rather than 'unsafe-inline', which would
// also license any script an XSS managed to inject. Hashing it here instead
// of pasting a literal 'sha256-...' keeps the two in sync automatically if
// that script ever changes; if it ever disappears, this fails the build
// loudly rather than silently shipping a CSP that blocks nothing.
function inlineScriptHash() {
  const html = readFileSync(resolve(here, 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('index.html: no bare inline <script> found to hash for CSP');
  return `'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  // Plausible is a bundled dependency (@plausible-analytics/tracker), not a
  // remote <script>, so its origin only ever needs connect-src, for the
  // /api/event beacon — never script-src.
  const connectSrc = [
    "'self'",
    originOf(env.VITE_ARC_RPC_URL) || ARC_RPC_DEFAULT,
    originOf(env.VITE_SEPOLIA_RPC_URL) || SEPOLIA_RPC_DEFAULT,
    originOf(env.VITE_PLAUSIBLE_ENDPOINT)
  ].filter(Boolean).join(' ');
  const scriptSrc = ["'self'", inlineScriptHash()].join(' ');

  return {
    plugins: [
      {
        // Cloudflare's `_headers` file has no templating, and the Plausible
        // origin it needs to allow-list is only known once VITE_* env vars
        // are read — so it's generated here rather than committed as a
        // static public/_headers. web/nginx.conf's Docker deployment gets no
        // CSP from this: nginx doesn't read the `_headers` convention, and
        // giving it an equivalent policy is a separate piece of work.
        name: 'verdikt-security-headers',
        writeBundle(options) {
          writeFileSync(
            resolve(/** @type {string} */ (options.dir), '_headers'),
            `/*\n  Content-Security-Policy: script-src ${scriptSrc}; connect-src ${connectSrc}\n`
          );
        }
      }
    ]
  };
});
