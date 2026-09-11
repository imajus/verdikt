# Landing page, real routes, service-detail page, and legal pages

Status: approved. Splits the dashboard's single query-param "view" toggle into
real, shareable URL paths; adds a landing page ahead of the marketplace; pulls
service detail out of the marketplace's split screen into its own page; adds
a login redirect to the provider console; and adds static Terms/Privacy
pages.

## Why this touches routing, not just new pages

`web/src/router.js` today is deliberately query-param-only
(`?view=marketplace|provider|how`, `?service=`, `?provider=`), because the
dashboard ships as static files on two targets that have no server to
configure an SPA fallback on. Real paths (`/marketplace`, `/services/:slug`,
`/terms`, …) change that premise: an unmatched path now needs to resolve to
`index.html` on both deploy targets, or a hard refresh on `/marketplace` 404s.
That infra change is small but load-bearing, so it's covered explicitly in §5
rather than left implicit.

## 1 · Route table

`web/src/router.js` is rewritten from query-param parsing to pathname
parsing. `readRoute(url)` becomes `parseRoute(url)`, returning the same kind
of discriminated shape consumers already expect:

```
{ view: 'landing'|'marketplace'|'service'|'provider'|'how'|'terms'|'privacy',
  slug: string|null,      // set when view === 'service'
  address: string|null }  // set when view === 'provider' and it's a shared link
```

| Path | `view` |
|---|---|
| `/` | `landing` |
| `/marketplace` | `marketplace` |
| `/services/:slug` | `service` |
| `/provider` | `provider` (own — resolves against the connected wallet) |
| `/provider/:address` | `provider` (shared link to `:address`) |
| `/how` | `how` |
| `/terms` | `terms` |
| `/privacy` | `privacy` |
| anything else | redirect (`replaceState`) to `/marketplace` |

**Backward compatibility:** a bare `?provider=0x…` hit — the one link
documented today as a public, shareable deep link — is caught and
client-side redirected (`replaceState`) to `/provider/0x…`. No other legacy
query param (`?view=`, `?service=`) gets redirect handling: those params were
introduced alongside this same router file and nothing indicates they were
ever shared externally, so carrying them forward would be speculative.

URL-building helpers replace `withService`/`withProvider`/`withView`:
`serviceUrl(slug)`, `providerUrl(address)`, plus path constants for the
static views. Each returns a path string, not a `URL` — there's no query
state left to preserve across a navigation.

## 2 · Navigation model

Because these are now real pages rather than view toggles, navigating between
them uses `history.pushState` (so back/forward works), with a `popstate`
listener in `main.js` calling the existing `draw()`. This replaces today's
`history.replaceState` calls in the `service-select`/`view-select` handlers.
In-page interactions that aren't a page change (theme, wallet menu) are
unaffected.

## 3 · Landing page (`/`)

New file `web/src/pages.js`, exporting Lit template functions for the pages
that don't belong to `lit-app.js`'s existing marketplace/provider/how
templates. `landing()` renders the brand, the existing tagline copy
(`TAGLINE` in `lit-app.js`, reused rather than duplicated), and a single
"Browse the marketplace" call-to-action linking to `/marketplace`. It loads
no chain data and doesn't wait on `loadMarketplace()` — `main.js`'s `render()`
dispatch can show it immediately regardless of marketplace load state.

The brand/logo link (`brand()` in `lit-app.js`) changes from linking to `?`
(today's marketplace) to `/` (landing).

## 4 · Marketplace and service detail split

`renderMarketplace` in `lit-app.js` drops its embedded `detailTemplate` split
screen — it becomes figures + listing only. Clicking a listing row navigates
(pushState) to `/services/:slug` instead of mutating a `?service=` param.

A new top-level branch in `render()` handles `view === 'service'`: look up
the listing by slug from the loaded marketplace, reuse the existing
(already-exported) `detailTemplate`, and add a "back to marketplace" link. An
unknown slug falls back to the router's own not-found handling (redirect to
`/marketplace`) rather than rendering an empty detail pane.

The provider console (`renderProvider`) is **not** restructured the same way.
It keeps its own listing + `detailTemplate` + SLA/bond editors for whichever
owned service is selected. Which one is selected becomes ordinary component
state (an instance property on `VerdiktApp`, defaulting to `owned[0]` as
today) rather than URL-encoded — the provider console is a self-service admin
panel, not something with a per-service sharing use case, so there's no
reason to invent a third URL level (`/provider/:address/services/:slug`) for
it.

## 5 · Deploy target changes (SPA fallback)

Both static-hosting paths need an unmatched path to resolve to `index.html`:

- **Cloudflare Workers assets** (`web/wrangler.jsonc`): add
  `"not_found_handling": "single-page-application"` under `assets`.
- **nginx/Docker** (`web/Dockerfile`, `docker-compose.yml`): add
  `web/nginx.conf` with a `try_files $uri /index.html;` location block, and
  `COPY` it to `/etc/nginx/conf.d/default.conf` in the `nginx:1.27-alpine`
  stage.

Vite's dev server needs no change — its default `appType: 'spa'` already
falls back to `index.html` for unmatched paths, so `pnpm dev` serves
`/marketplace` correctly today even before this change.

## 6 · Login redirect to the provider console

In `main.js`, the `wallet-connect` event handler — fired only by the nav's
explicit "Connect wallet" button — navigates (pushState) to
`/provider/<connected address>` once `connectWallet()` resolves. This fires
regardless of which page the user was on, since connecting a wallet in this
app has no purpose today other than provider self-management.

`restoreWallet()`'s silent auto-reconnect on page load (Web3-Onboard's
`autoConnectLastWallet`) never touches this handler — it flows through
`syncWallets` → `onAccountChange` listeners instead — so it never triggers
the redirect. This is what "not if automatically logged-in" means concretely:
the distinction is already structural in `wallet.js`, not something new to
build.

SIWE sign-in (`provider-sign-in` / "Enable provider actions") is unaffected —
it's only ever reachable from within the provider console already, so it
needs no redirect of its own.

## 7 · Terms and Privacy

`web/src/pages.js` also exports `terms()` and `privacy()`. Content is
placeholder boilerplate honestly describing what the app actually does: no
accounts, no backend, non-custodial (the browser reads Arc and Sepolia
directly over RPC), on-chain data (verdicts, bonds, refunds) is public by
nature of the chain, no warranty. Clearly template legal text, not reviewed
legal advice — a comment at the top of the file says so.

## 8 · Nav and footer

Top nav (`nav()` in `lit-app.js`) is otherwise unchanged: Marketplace /
Provider (live mode only) / How it works, theme toggle, GitHub/X, wallet
button. Terms and Privacy are not added to the top nav; instead a small new
footer partial — just the two legal links, nothing else — is added once in
`render()` and appears on every page.

## 9 · Testing

- `web/src/router.test.js` rewritten for pathname parsing: each path in the
  table above round-trips; the `?provider=0x…` legacy redirect is asserted
  explicitly (this is the one compatibility guarantee carried forward); an
  unrecognized path falls back to `/marketplace`.
- A test for the `wallet-connect` → redirect wiring, asserting the silent
  `restoreWallet()` path does not navigate.
- Existing `marketplace.test.js`/`provider.js` consumers updated for the
  route shape rename (`readRoute` → `parseRoute`, `service`/`provider` fields
  → `slug`/`address`).

## Explicitly out of scope

- No change to `renderProvider`'s internal service-selection UX beyond
  dropping its URL coupling (§4) — no new sub-route for it.
- No dynamic per-route `<meta>`/OG tag updates — `index.html`'s existing
  static meta tags are unchanged; only `document.title` is updated per route
  for basic tab/history legibility.
- No redirect handling for the pre-existing `?view=`/`?service=` query
  params — only the documented `?provider=` deep link is carried forward
  (§1).
- No accessibility or SEO audit of the new static pages beyond what the
  existing templates already do (semantic headings, `alt` text, etc.).
