# Provider route and authorization boundaries

The provider console currently conflates two questions: *whose console is
this* and *what may I do here*. `resolveProviderConsole` falls back to the
connected wallet when the path carries no address, so `/provider` renders a
different page depending on who is looking — and when nobody is connected it
silently renders the **marketplace** under a "Provider" title with the
Provider nav item highlighted.

This change separates the two:

- **Routing decides whose data is shown.** Only a valid address in the path
  selects a provider. Nothing else — not the connected wallet, not a session.
- **Authorization decides what is rendered on that page.** It never changes
  which provider's data appears, only whether the write controls exist.

## 1 · Routing

`web/src/router.js` validates the address instead of accepting any path
segment:

```js
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
```

| URL | `address` | `rejected` | `canonicalPath` |
| --- | --- | --- | --- |
| `/provider` | `null` | `null` | `/provider` |
| `/provider/0x…` (40 hex) | the address | `null` | unchanged |
| `/provider/foo` | `null` | `'foo'` | unchanged (`/provider/foo`) |
| `/?provider=0x…` (40 hex) | the address | `null` | `/provider/0x…` |
| `/?provider=foo` | `null` | `null` | `/provider` |

After `parseRoute`, `route.address` is **either a valid address or null**. No
consumer re-validates.

`rejected` is a new field on the route, non-null only when a `/provider/…`
path segment failed validation. It exists so the address-less view can name
what was rejected while the bad URL stays in the address bar; a legacy
`?provider=` value is not carried into it, because that path *is* rewritten
and there would be nothing left on screen to explain.

Titles are unchanged: both provider states are `Provider — Verdikt`.

## 2 · `provider.js` forgets the wallet exists

```js
export function resolveProviderConsole(services, address) {
  const owned = address ? services.filter(…) : [];
  return { owned, target: owned[0] ?? null };
}
```

The `view` and `account` parameters go, and with them `effectiveProvider` —
it is just `address` now. The removed line

```js
const effectiveProvider = routeAddress ?? (view === 'provider' ? account : null);
```

is the whole defect: it let the connected wallet decide which data to show.

## 3 · The address-less state

New `providerPrompt(mode, account, rejected, connect, go)` in
`web/src/pages.js` — it needs no `Marketplace` and no `Listing`, which is
that file's admission criterion. It uses the standard `pageHead('Provider', …)`:

- **rejected** — a leading line naming what was rejected.
- **connected** — the connected address, and a link to its own console.
- **not connected, live mode** — a prompt plus the Connect wallet button.
- **demo mode** — the same prompt without the connect affordance. Provider
  consoles read Arc; demo mode has no wallet button in the nav either.

`render()` places it with landing/terms/privacy — **before** the `this.error`
and `!this.marketplace` guards. Same reasoning as the comment already there:
it needs no chain data, and a dead RPC must not strand a visitor on a page
with no navigation.

The nav item stays visible whenever `mode === 'live'` (spec §8 of
`2026-09-11-landing-routing-legal-design.md` is unchanged), but points at
`providerUrl(account)` when a wallet is connected, so the address-less path is
only reached by typing it.

## 4 · Write sections render only for the owner

In `renderProvider`, one flag mirroring what `main.js` mounts:

```js
const canWrite = signedIn && supported;   // signedIn already implies ownPage
```

`canWrite` gates the *Add a service*, *SLA editor* and *Bond* sections out of
the template entirely. A visitor to someone else's console sees only the
public record: figures, listings, detail.

The sign-in aside (`ownPage && (!signedIn || !supported)`) is untouched — it
remains the one discoverable way to unlock them.

`canWrite` must keep its short-circuit order: `ownPage` is evaluated before
`getSession()`, so server-side rendering never touches `localStorage`.

Because the mounts no longer exist when you cannot write,
`mountProviderConsole`'s three `else` branches — setting `deps = null` and a
message like *"Connect as this service's own provider to publish changes"* —
are dead and are deleted. The `SEPOLIA.subnameRegistrar` message stays: that
is a build-configuration fact, not an authorization one, and it appears on a
page where the wizard *is* rendered.

`canWrite` and `main.js`'s `sessionMatchesAccount && viewingOwnPage` are a
mirrored pair in the sense `CLAUDE.md` uses the term. If they drift, controls
render dead or mount invisibly. A test pins them.

## 5 · The stale-control guard

`draw()`'s pre-patch `clearProviderControls(false)` fires today when the route
has no `target`. It becomes "this page is not writable by the connected
account", which also covers navigating from your own console straight to
another provider's — where a target exists but the controls must not survive
the patch.

## 6 · Testing

- `router.test.js` — existing fixtures use `0xAaAa`, which stops being an
  address; they become real 40-hex addresses. New cases: `/provider/foo`
  yields `address: null` with `rejected: 'foo'`, and `?provider=foo`
  canonicalises to `/provider`.
- New `provider.test.js` — the module has never had one. Now that it is a
  pure two-argument filter: null address, no matches, matches, and `target`
  as the first owned listing.
- `main.test.js` — the `querySelector` stub returns mounts unconditionally, so
  deleting the `else` branches changes nothing it asserts. One case added:
  disconnected at `/provider/0x…` leaves every `deps` null.
- Render coverage for the four prompt states, and for the write sections being
  absent on a stranger's console.

## Explicitly out of scope

- No address checksumming or normalisation in `canonicalPath`. Comparison
  stays case-insensitive, as it is today.
- No change to `renderProvider`'s service-selection UX.
- No new route or view for the address-less state — it is the `provider` view
  with a null address.
