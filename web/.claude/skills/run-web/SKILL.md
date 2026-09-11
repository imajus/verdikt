---
name: run-web
description: Build, run, and drive the Verdikt marketplace dashboard (web). Use when asked to start the web dashboard, run the Vite dev server, screenshot the marketplace or provider view, click through the onboarding wizard, or check a UI change in the real app rather than in tests.
---

Verdikt's dashboard is a static Vite + Lit single page — no server-side logic, it
reads Arc and Sepolia straight from the browser. So "run it" means: start the dev
server, point whatever browser tooling you have at `http://localhost:5173`, and
drive the DOM. This skill does not ship a browser driver; use the one your session
already has (Chrome DevTools MCP, `playwright-cli`, `chromium-cli`, Puppeteer —
all of them work, the page is ordinary HTTP). The recipes below are plain JS
snippets for whatever `evaluate`/`eval` your driver exposes.

All paths are relative to `web/`.

## Prerequisites

Node ≥ 22 and pnpm (the repo pins `pnpm@12.3.4` via `packageManager`). Verified
here on Node v24.16.0 / pnpm 12.3.4. Nothing else — no OS packages, no browser
download; the dashboard is served over plain HTTP to a browser you already have.

```bash
pnpm install --frozen-lockfile
```

## Run (agent path)

Start the dev server detached and **poll the port** — don't `sleep`:

```bash
cd web && (pnpm dev > /tmp/vite-web.log 2>&1 &)
timeout 30 bash -c 'until curl -sf http://localhost:5173/ >/dev/null; do sleep 0.5; done'
```

Then navigate your browser tool to `http://localhost:5173/` and wait for the text
`Verdikt` before touching anything. Stop it with `fuser`, not `lsof` (see Gotchas):

```bash
fuser -k 5173/tcp
```

Routes are **real URL paths** (`src/router.js`), and deep links can be
navigated directly:

| URL | view |
|---|---|
| `http://localhost:5173/` | landing page |
| `http://localhost:5173/marketplace` | marketplace listing |
| `http://localhost:5173/services/weather-lite` | that service's standalone detail page |
| `http://localhost:5173/how` | "How it works" |
| `http://localhost:5173/provider` | provider console (connected wallet) |
| `http://localhost:5173/provider/0xA11ce00000000000000000000000000000000001` | provider console for that address |
| `http://localhost:5173/terms` | Terms of Service |
| `http://localhost:5173/privacy` | Privacy Policy |

A legacy `?provider=0x…` deep link still resolves — `parseRoute` rewrites it
forward to `/provider/0x…` via `history.replaceState` on load — but
`?service=…`/`?view=…` query params are no longer read; those now fall
through to the marketplace/landing route.

Because routes are real paths, both deploy targets need (and have) an SPA
fallback that serves `index.html` for any unmatched path: `web/wrangler.jsonc`'s
`not_found_handling` for the Cloudflare Worker target, and `web/nginx.conf`'s
`try_files` for the Docker/nginx target. Vite's own dev server already falls
back to `index.html` for any path by default, so local dev needs no extra
config — a hard refresh on e.g. `http://localhost:5173/marketplace` just works.

Clicking a service row follows a real `<a href>` and updates the URL:

```js
// after clicking the "weather-lite" row
({ url: location.href, selected: document.querySelector('h2')?.textContent })
// -> { url: ".../services/weather-lite", selected: "weather-lite" }
```

### Demo data vs. live mode

With no `VITE_ARC_RPC_URL` in `web/.env.local`, the header reads **"demo
data"** with a "Showing seeded data, not a live chain" banner — two seeded
services (`weather` ACTIVE, `weather-lite` SUSPENDED), 34 verdicts, a refund
history, deterministic and offline. That's what you want for UI work that
doesn't care about real chain state.

Set `VITE_ARC_RPC_URL` (and `VITE_SEPOLIA_RPC_URL`) to a provider that
tolerates the registry's log scan and `pnpm dev` goes live too — no build
step needed, confirmed against a running dev server. It works with a properly
configured Alchemy Arc Testnet app: real services, real block numbers, a
"Connect wallet" button that demo mode doesn't show. The default public
endpoint and a misconfigured provider both fail in their own way — see
Gotchas.

### Driving the provider console and the onboarding wizard

`verdikt-wizard`, `verdikt-sla-editor` and `verdikt-bond-controls` render on the
`/provider/:address` route in demo mode, but `main.js` only injects their `deps` when
`mode === 'live'`, so they mount **inert**: `document.querySelector('#wizard-mount').deps === null`
and the element renders nothing.

You do not need live mode to drive them. `deps` is a plain object of injected
functions, so assign it yourself. This is the harness for any wizard/SLA/bond
change — verified working against the running dev server:

```js
// navigate to /provider/0xA11ce00000000000000000000000000000000001 first
const w = document.querySelector('#wizard-mount');
w.deps = {
  account: '0x4088f83b25Ff1dcc8bd1D88250e316ed5AB29AEE',
  registrarAddress: '0x247e46abe002c034CD99D8d81D7e6182b727ac7d',
  registryAddress: '0xe182626142e63ef440421cb0c5e4debeef76e4af',
  depositAmount: 10n ** 19n,
  sepoliaRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  formatNativeUsdc: (v) => String(v / 10n ** 18n),
  // stub the signing surface — nothing below ever reaches a wallet
  walletClientFor: () => ({ writeContract: async () => '0xstub', sendTransaction: async () => '0xstub' }),
  ensureSepolia: async () => {}, ensureArc: async () => {}, onDone: () => {}
};
await w.updateComplete;   // -> step 1 "Claim the subname", slug input, disabled Claim button
```

Typing a slug fires a **real ENS lookup on Sepolia**, so it is a genuine
round trip and takes a second or two:

```js
const input = document.querySelector('#wizard-slug');
input.value = 'weather';
input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
// poll w.availability until it stops being 'Checking…'
// 'weather'          -> "Already claimed by 0x9cBb40D45ec9dD095309BBA505f3BC54e63A3a79.", available: false
// 'anything-unused'  -> "Available.", available: true, Claim button enabled
```

Stub `walletClientFor` and the wizard will walk steps 2 and 3 without a wallet or
a real transaction. Give it a real `walletClient` only when you actually intend to
spend Sepolia and Arc funds.

## Run (human path)

```bash
cd web && pnpm dev      # -> http://localhost:5173, hot reload. Ctrl-C to stop.
```

Also runnable from the repo root without `cd`, which is handy when you don't want
to move the shell:

```bash
pnpm --filter @verdikt/web dev --port 5199
```

## Build

```bash
cd web && pnpm build    # vite build -> web/dist, ~550ms
pnpm preview --port 4173
```

`pnpm run deploy` is `vite build && wrangler deploy`. Note **`pnpm run deploy`**,
not `pnpm deploy` — the latter is pnpm's own command. Not exercised here (it
publishes to Cloudflare).

## Test

```bash
pnpm vitest run web/     # 8 files, 85 tests, ~1.2s
pnpm typecheck           # clean
npx eslint web/src       # clean
```

Run eslint **scoped to `web/src`**. Repo-root `pnpm lint` currently reports 237
errors, none of them in `web` — see Troubleshooting.

## Gotchas

- **Vite's dev-mode `import.meta.env` injection is a raw-text scan, not an AST
  transform — a wrapping cast can hide the expression from it.** `web/src/main.js`
  used to read the env through a JSDoc cast written as
  `(/** @type {any} */ (import.meta).env ?? {})`. The parenthesised
  `(import.meta).env` doesn't contain the *contiguous* text `import.meta.env`,
  which is what Vite's dev server greps a module for to decide whether to inject
  an `import.meta.env = {...}` shim (confirmed by diffing the served module
  against the raw source: no shim was ever inserted for that line, while a
  throwaway file using plain `import.meta.env` got one). So in dev,
  `import.meta.env` stayed genuinely `undefined`, `?? {}` silently won, and
  `createSource` always fell through to demo data — **regardless of
  `.env.local`**. The production build was never affected; a real bundler
  resolves the parenthesised form fine, so `pnpm build` always inlined the
  value correctly. Fixed by dropping the cast to plain `import.meta.env ?? {}`
  and adding `/// <reference types="vite/client" />` to `web/types.d.ts` so it
  still typechecks (`ImportMeta` has no `.env` without that reference — that's
  a genuine type error, unrelated to `strict` mode, so disabling `strict` in
  `jsconfig.json` would not have fixed it and would have widened blast radius
  to `proxy`/`cre`/`runner`/`packages` for nothing). If you ever see this
  pattern reappear — a wrapped/parenthesised `import.meta.*` access — expect
  the same silent dev-only fallback.

- **The default public Arc RPC throttles the live-mode log scan.** `pnpm build && pnpm preview`
  against `https://rpc.testnet.arc.network` (no `VITE_ARC_RPC_URL` override) dies with
  `Request exceeds defined limit … rate limit exceeded`. The registry reader scans
  from `deployBlock` 60860488 to head (~61.44M) in 10k-block chunks — 57
  sequential `eth_getLogs` calls per event signature — and the public endpoint
  throttles partway through. Single calls at any range up to 10k succeed, so the
  endpoint is not the problem; the volume is. Point `VITE_ARC_RPC_URL` at a
  provider that tolerates the scan (an Alchemy app worked — see next two points).

- **An Alchemy RPC app's origin allowlist rejects the browser with a *different*
  error than a missing/wrong URL, and it's easy to mistake for the rate-limit
  Gotcha above.** The symptom in the UI is generic: `Could not load the
  marketplace: HTTP request failed … Failed to fetch`, and the browser console
  shows `blocked by CORS policy: No 'Access-Control-Allow-Origin' header is
  present`. That's misleading — the preflight `OPTIONS` request *does* return a
  permissive `access-control-allow-origin`, but the actual `POST` gets a plain
  `403` with **no CORS headers at all** (confirm with `curl -i -X POST <rpc-url>
  -H "Origin: http://localhost:4173" -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`
  — a body of `{"error":{"code":-32600,"message":"Origin localhost is not on
  whitelist."}}` is the tell), and a response with no CORS headers is exactly
  what a browser reports as an opaque "Failed to fetch" rather than surfacing
  the 403. The fix is on the Alchemy app itself: add the exact origin the
  browser sends — `http://localhost:4173` and/or `http://localhost:5173` (the
  message says `Origin localhost …`, dropping the port, but the app still
  needs the full `scheme://host:port` entry to match) — to that specific app's
  domain allowlist. It is a per-app setting: the same API key can back two
  Alchemy apps (one per chain here, since `VITE_ARC_RPC_URL` and
  `VITE_SEPOLIA_RPC_URL` share a key suffix in this repo's `.env.local`), each
  with its own independent allowlist.

- **Even a correctly allowlisted Alchemy key shows a handful of `net::ERR_FAILED`
  requests during the log scan, and that's fine.** Of ~75 `eth_getLogs` POSTs for
  one page load, 6–8 individually failed in the network panel while the page
  still rendered complete, correct live data. Don't treat a stray `ERR_FAILED` in
  `list_network_requests` as a broken run — check what actually rendered
  (`Arc Testnet` badge, real block numbers, a working "Connect wallet" button)
  before concluding live mode is broken.

- **Env vars are read at build time and inlined.** A built `dist/` or a running
  container cannot be repointed at another chain without rebuilding. Anything
  `VITE_`-prefixed ships to the browser in clear text.

- **Vite binds IPv6 `[::1]` only.** `curl http://localhost:5173` returns 200;
  `curl http://127.0.0.1:5173` is refused outright. Use `localhost` in every URL
  you hand a browser or a health check. `ss -lptnH 'sport = :5173'` shows the bind.

- **Shadow DOM is uneven.** Verdikt's own Lit components override
  `createRenderRoot()` to render into the light DOM, so `document.querySelector('#wizard-mount')`,
  `#wizard-slug`, `h2`, and the service rows all resolve normally. But the
  WebAwesome primitives they contain (`wa-input`, `wa-button`, `wa-button-group`)
  are real shadow roots. Set `.value` on the `wa-input` **host** and dispatch
  `input` with `{ bubbles: true, composed: true }` — that is what the Lit binding
  listens for. Reaching into the inner `<input>` is unnecessary.

- **The wizard is inert until you assign `deps`.** No error, no warning — the
  element simply renders nothing (`if (!this.deps) return nothing`). If a provider
  page looks empty, that is why, not a broken build.

## Troubleshooting

- **Header says "demo data" even though `VITE_ARC_RPC_URL` is set**: as of the
  `import.meta.env` fix (first Gotcha), `pnpm dev` picks it up directly — no
  rebuild needed. If it's still showing demo data, restart the dev server —
  Vite reads `.env.local` when it starts, not on every request, so an edit
  made while `pnpm dev` was already running won't be picked up until restart
  (not independently verified this session, but standard Vite behavior — if
  it doesn't fix it, look elsewhere before assuming this).

- **`Could not load the marketplace: Request exceeds defined limit … rate limit exceeded`**:
  live mode against the *default* public Arc RPC. First live-mode Gotcha. Not a
  code fault; supply a higher-limit `VITE_ARC_RPC_URL` and rebuild.

- **`Could not load the marketplace: HTTP request failed … Failed to fetch`, with
  `blocked by CORS policy` in the console**: an Alchemy (or similar) RPC app that
  doesn't have the dashboard's exact origin on its domain allowlist yet. Second
  live-mode Gotcha — this is a dashboard-side origin config, not a rate limit,
  and adding the origin can take longer than a few seconds to take effect even
  after saving.

- **`pnpm lint` fails with ~237 errors at line 20109 of something**: they come from
  stale Cloudflare bundles in `proxy/.wrangler/tmp/` (`middleware-insertion-facade.js`,
  `worker.js`), left behind by a previous `wrangler dev`. `eslint.config.js` ignores
  `**/dist/**` but not `.wrangler/tmp`. Nothing to do with `web` —
  `npx eslint web/src` exits 0. Clear it with `rm -rf proxy/.wrangler/tmp` if it
  is in your way.

- **`lsof: command not found`**: not installed here. Use `fuser -k 5173/tcp` to
  free the port, or `ss -lptnH 'sport = :5173'` to see what holds it. Avoid broad
  `pkill -f` patterns — they can match the agent's own process.

- **Screenshot call hangs for minutes**: happened once, on a page that was not the
  browser's selected/foreground tab. Select the page first, then capture.

- **`[vite] connected` and a Lit dev-mode warning in the console**: both normal.
  A clean run has no other console output.
