# Provider listing and registration wizard implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the provider console into a pure listing (like the marketplace), move per-service SLA/bond management onto that service's own page, and replace the two-halves registration form with a `/register` wizard that collects every input before it signs anything.

**Architecture:** `web/src/router.js` gains one static view (`/register`). `web/src/lit-app.js`'s `renderProvider` drops its detail pane and write sections down to a listing; `renderService` gains the SLA/bond sections, gated by a new `writeAuthorization(providerAddress)` helper shared with a new `renderRegister`. `web/src/main.js`'s `providerAuthorization`/`mountProviderConsole` resolve their target and mount point by `route.view` (`service` → SLA+bond, `register` → wizard) instead of always assuming the provider page. `web/src/forms/wizard.js` is rewritten so steps 1–3 are pure form state and step 4 runs the four existing transactions (`claimSubname` → `registerService` → `publishUrl` → `publishSla`) from a resumable cursor.

**Tech Stack:** Lit (light-DOM `LitElement`s), Vitest, `@lit-labs/ssr` for DOM-free template assertions (`web/src/render.js`).

## Global Constraints

- JS with ESM throughout, not TypeScript. Ambient ` *.d.ts` types, JSDoc referencing them — no new `export` in `web/types.d.ts`.
- No blank lines inside function bodies for visual separation (user's global JS/TS guide).
- The transaction order in `web/src/forms/wizard.js` — claim → register → url → sla — is fixed by `docs/superpowers/specs/2026-09-11-provider-listing-registration-wizard-design.md` §4.2 and must not change: ENS is claimed before Arc registration so a newly registered service can never begin life with conflicting ownership.
- `/register` carries no address in its path (design §1) — it always acts on the connected wallet.
- Refund/verdict/SLA-evaluation invariants in `CLAUDE.md` are untouched by this plan; nothing here writes a verdict or touches `packages/sla`.
- Run `pnpm lint` and `pnpm typecheck` from the repo root after the plan's tasks; `pnpm --filter web test` (or `pnpm vitest run web/src/...`) per task.

---

## File structure

| File | Change |
| --- | --- |
| `web/src/router.js` | add `REGISTER_PATH`, `/register` static view, its title |
| `web/src/router.test.js` | cover `/register` |
| `web/src/landing.js` | repoint the "list a service" link to `REGISTER_PATH` |
| `web/src/landing.test.js` | assert the link's href |
| `web/src/lit-app.js` | `writeAuthorization()`; `renderProvider` → pure listing; `renderService` gains owner controls; new `renderRegister`; `render()` dispatch |
| `web/src/marketplace.test.js` | rewrite the provider/service/register rendering `describe` blocks |
| `web/src/main.js` | `providerAuthorization`, `draw`, `mountProviderConsole` become route-aware (`service` / `register`) |
| `web/src/main.test.js` | full rewrite of the mounting/wiring tests |
| `web/src/forms/wizard.js` | rewrite: 4-step collect-then-execute, resumable on failure |
| `web/src/forms/wizard.test.js` | new |
| `web/src/styles.css` | wizard nav/review/progress rules |

No change to `web/src/forms/sla-editor.js`, `web/src/forms/bond.js`, `web/src/actions.js`, `web/src/provider.js`, `web/src/pages.js`, or anything outside `web/`.

---

### Task 1: `/register` route

**Files:**
- Modify: `web/src/router.js`
- Test: `web/src/router.test.js`

**Interfaces:**
- Produces: `REGISTER_PATH = '/register'`, exported alongside the other path constants. `parseRoute` returns `{ view: 'register', slug: null, address: null, rejected: null, canonicalPath: '/register' }` for it. `titleFor` returns `'List a service — Verdikt'`.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/router.test.js`, inside the existing `describe('parseRoute', ...)` block (after the `how/terms/privacy` test):

```js
  it('reads the register path', () => {
    expect(parseRoute(new URL('https://verdikt.example/register'))).toEqual({ view: 'register', slug: null, address: null, rejected: null, canonicalPath: '/register' });
  });
```

Add to the existing `describe('titleFor', ...)` block:

```js
  it('titles the register page', () => {
    expect(titleFor(parseRoute(new URL('https://verdikt.example/register')))).toBe('List a service — Verdikt');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web vitest run src/router.test.js`
Expected: FAIL — `view` is `'marketplace'` (register isn't a recognized path yet) and the title assertion returns `'Verdikt'`.

- [ ] **Step 3: Implement**

In `web/src/router.js`, add the constant next to the others:

```js
export const REGISTER_PATH = '/register';
```

Add it to `STATIC_VIEWS`:

```js
const STATIC_VIEWS = /** @type {Record<string, string>} */ ({
  '/': 'landing',
  [MARKETPLACE_PATH]: 'marketplace',
  [HOW_PATH]: 'how',
  [TERMS_PATH]: 'terms',
  [PRIVACY_PATH]: 'privacy',
  [REGISTER_PATH]: 'register'
});
```

Update the `parseRoute` return-type JSDoc's `view` union to include `'register'`, and `TITLES`:

```js
const TITLES = /** @type {Record<string, string>} */ ({
  landing: 'Verdikt — Verified x402 API Marketplace',
  marketplace: 'Marketplace — Verdikt',
  provider: 'Provider — Verdikt',
  register: 'List a service — Verdikt',
  how: 'How it works — Verdikt',
  terms: 'Terms — Verdikt',
  privacy: 'Privacy — Verdikt'
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web vitest run src/router.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add web/src/router.js web/src/router.test.js
git commit -m "Add the /register route"
```

---

### Task 2: Repoint the landing page's provider link

**Files:**
- Modify: `web/src/landing.js`
- Test: `web/src/landing.test.js`

**Interfaces:**
- Consumes: `REGISTER_PATH` from Task 1.

- [ ] **Step 1: Write the failing test**

In `web/src/landing.test.js`, find the test around the `'list a service of your own'` assertions (currently `expect(stringify(landing(() => {}, services, 'live'))).toContain('list a service of your own');`) and tighten it:

```js
  it('points the provider CTA at the registration wizard, only in live mode', () => {
    const live = stringify(landing(() => {}, services, 'live'));
    expect(live).toContain('list a service of your own');
    expect(live).toContain('href="/register"');
    expect(stringify(landing(() => {}, services, 'demo'))).not.toContain('list a service of your own');
  });
```

Remove the two now-redundant lines this replaces (the original `toContain`/`not.toContain` pair at that spot).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter web vitest run src/landing.test.js`
Expected: FAIL — the rendered href is `/provider`, not `/register`.

- [ ] **Step 3: Implement**

In `web/src/landing.js`, change the import:

```js
import { HOW_PATH, MARKETPLACE_PATH, REGISTER_PATH, navigateOnClick } from './router.js';
```

And the CTA line:

```js
        ${mode === 'live' ? html`<a class="cta-aside" href=${REGISTER_PATH} @click=${navigateOnClick(go, REGISTER_PATH)}>or list a service of your own</a>` : nothing}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter web vitest run src/landing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/landing.js web/src/landing.test.js
git commit -m "Point the landing page's provider CTA at /register"
```

---

### Task 3: `renderProvider` becomes a pure listing

**Files:**
- Modify: `web/src/lit-app.js`
- Test: `web/src/marketplace.test.js` (the `describe('the provider view', ...)` block)

**Interfaces:**
- Produces: `VerdiktApp.prototype.writeAuthorization(providerAddress: string|null) → { ownPage: boolean, signedIn: boolean, supported: boolean, canWrite: boolean }`, used by `renderProvider` (Task 3), `renderService` (Task 4) and `renderRegister` (Task 5).
- `renderProvider(owned, provider, go)` keeps its current signature and caller (`render()`'s `provider` branch, unchanged: `this.renderProvider(resolveProviderConsole(services, this.route.address).owned, this.route.address, go)`).

- [ ] **Step 1: Write the failing tests**

Replace the two mount-presence assertions inside `describe('the provider view', ...)` in `web/src/marketplace.test.js` — the file already imports `REGISTER_PATH`-shaped hrefs indirectly via `renderApp`, no new import needed here. Replace:

```js
  it('says so plainly when an address owns nothing', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, '0xdead00000000000000000000000000000000dead');
    expect(html).toContain('No services registered');
    expect(html).not.toContain('sla-editor-mount');
    expect(html).not.toContain('bond-controls-mount');
  });
```

with:

```js
  it('says so plainly when an address owns nothing', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, '0xdead00000000000000000000000000000000dead');
    expect(html).toContain('No services registered');
  });
```

Replace:

```js
  // A console is a public page, so a visitor sees the record and nothing to
  // act on it with. No wallet is connected in this render, which is exactly
  // the case: the write sections are absent, not disabled.
  it('renders no write controls for anyone but the signed-in owner', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, PROVIDER);
    expect(html).toContain('weather');
    expect(html).not.toContain('wizard-mount');
    expect(html).not.toContain('sla-editor-mount');
    expect(html).not.toContain('bond-controls-mount');
  });
});
```

with:

```js
  // The provider console is a listing now, full stop — SLA and bond
  // management live on the service's own page (Task 4), registration at
  // /register (Task 5). No mount of any kind belongs here, signed in or not.
  it('renders no write controls at all, signed in or not', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, PROVIDER);
    expect(html).toContain('weather');
    expect(html).not.toContain('wizard-mount');
    expect(html).not.toContain('sla-editor-mount');
    expect(html).not.toContain('bond-controls-mount');
  });

  it('rows link to the service page, the same as the marketplace listing', async () => {
    const html = renderApp(await build(), 'demo', 'provider', null, PROVIDER);
    expect(html).toContain('href="/services/weather"');
  });
});
```

Now delete the `describe('who gets the provider console's write controls', ...)` block's wizard/sla/bond assertions against the `provider` view — that whole block moves to Task 4 (sla/bond, on a `service` render) and Task 5 (wizard, on a `register` render). For this task, replace the block with one that only checks the "+ add a service" link, which is the one write-adjacent thing the provider page still shows:

```js
// The provider console's one write-adjacent affordance: a link to /register,
// shown only on your own page. Whether that page lets you proceed is its own
// concern (Task 5) — this link must not itself require being signed in, or an
// owner who hasn't signed in yet would have no way to find registration.
describe('the provider console’s "add a service" link', () => {
  const build = async () =>
    loadMarketplace(deps({ services: [service('weather', HONEST)], verdicts: [], records: { weather: record({}) } }));
  /** @param {any} account */
  const as = (account) => { wallet.account = account; };

  afterEach(() => as(null));

  it('shows it on your own console, connected or not signed in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId });
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(html).toContain('href="/register"');
  });

  it('does not show it on somebody else’s console', async () => {
    const other = '0xB0b0000000000000000000000000000000000002';
    as({ address: other, chainId: ARC.chainId });
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(html).not.toContain('href="/register"');
  });

  it('does not show it to an unconnected visitor', async () => {
    const html = renderApp(await build(), 'live', 'provider', null, PROVIDER);
    expect(html).not.toContain('href="/register"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web vitest run src/marketplace.test.js`
Expected: FAIL — `renderProvider` still renders `sla-editor-mount`/`bond-controls-mount`/`wizard-mount` for the signed-in-owner case exercised via `'who gets the provider console's write controls'` (still present at this point, only reference block replaced above) and there is no `/register` link at all yet.

- [ ] **Step 3: Implement**

In `web/src/lit-app.js`, add the import:

```js
import { HOW_PATH, LANDING_PATH, MARKETPLACE_PATH, PROVIDER_PATH, REGISTER_PATH, navigateOnClick, providerUrl, serviceUrl } from './router.js';
```

Add the `writeAuthorization` method to `VerdiktApp` (place it right before `renderProvider`):

```js
  /**
   * Whether the connected wallet may write against `providerAddress`, and
   * why not when it can't. Shared by renderProvider, renderService and
   * renderRegister — a provider's own service page and the registration
   * wizard gate on the exact same four facts a provider console did before
   * this address moved off it.
   * @param {string|null} providerAddress
   */
  writeAuthorization(providerAddress) {
    const account = getConnectedAccount();
    const ownPage = Boolean(providerAddress && account?.address.toLowerCase() === providerAddress.toLowerCase());
    const supported = Boolean(account) && [ARC.chainId, SEPOLIA.chainId].includes(/** @type {{chainId: number}} */ (account).chainId);
    // `ownPage &&` first keeps getSession() — and localStorage — out of the
    // server-side render used by the tests.
    const signedIn = ownPage && getSession()?.address.toLowerCase() === account?.address.toLowerCase();
    const canWrite = Boolean(signedIn && supported);
    return { ownPage, signedIn, supported, canWrite };
  }
```

Replace `renderProvider` entirely with:

```js
  /** @param {Listing[]} owned @param {string} provider @param {(path: string) => void} go */
  renderProvider(owned, provider, go) {
    const auth = this.writeAuthorization(provider);
    const bonded = owned.reduce((total, listing) => total + listing.deposit, 0n);
    const refunded = owned.reduce((total, listing) => total + listing.history.reduce((sum, verdict) => sum + verdict.refunded, 0n), 0n);
    const verdicts = owned.reduce((total, listing) => total + listing.history.length, 0);
    return html`<header class="page-head"><div><p class="tagline">Provider <code>${provider}</code> · <a href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>back to the marketplace</a></p></div><p class="source">${owned.length} service${owned.length === 1 ? '' : 's'}${auth.ownPage ? html` · <a class="cta-aside" href=${REGISTER_PATH} @click=${navigateOnClick(go, REGISTER_PATH)}>+ add a service</a>` : nothing}</p></header>
      ${auth.ownPage && (!auth.signedIn || !auth.supported) ? html`<div class="aside"><p>${auth.signedIn ? 'Switch to a supported network to manage your services.' : 'Sign in once to manage your services. Your sign-in lasts 24 hours in this browser.'}</p><wa-button size="s" appearance="outlined" ?disabled=${this.signInPending} ?loading=${this.signInPending} @click=${this.signIn}>${auth.signedIn ? 'Switch network' : 'Enable provider actions'}</wa-button>${this.signInError ? html`<p role="status">${this.signInError}</p>` : nothing}</div>` : nothing}
      <section class="figures"><div class="figure"><span class="value">${owned.length}</span><span class="label">services</span></div><div class="figure"><span class="value">${amount(formatNativeUsdc(bonded, 2))}</span><span class="label">bonded</span></div><div class="figure"><span class="value ${refunded > 0n ? 'fail' : ''}">${amount(formatNativeUsdc(refunded, 2))}</span><span class="label">${auth.ownPage ? 'refunded from your bonds' : 'refunded from these bonds'}</span></div><div class="figure"><span class="value">${verdicts}</span><span class="label">verdicts</span></div></section>
      ${owned.length === 0 ? html`<p class="empty">No services registered by this address.</p>` : html`<section class="listing">${listingHead()}${owned.map((listing) => listingRow(listing, go))}</section>`}`;
  }
```

This drops `getConnectedAccount`/`getSession`/`ARC`/`SEPOLIA` direct use from `renderProvider` itself (moved into `writeAuthorization`), the `<div class="layout">` wrapper, `detailTemplate(target)`, the `Add a service` wizard section, the SLA editor section, and the bond section — and their now-dead `const target = owned[0]` / `signedIn` / `supported` / `canWrite` locals.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web vitest run src/marketplace.test.js`
Expected: the provider-view and "add a service" link tests PASS. The `describe('who gets the provider console's write controls', ...)` block will still FAIL on its `provider`-view wizard/sla/bond assertions — that's expected and resolved in Task 6, which rewrites that block. Confirm the failures are confined to that block (`pnpm --filter web vitest run src/marketplace.test.js 2>&1 | grep -A2 '✗\|FAIL'`) before moving on.

- [ ] **Step 5: Commit**

```bash
git add web/src/lit-app.js web/src/marketplace.test.js
git commit -m "Reduce the provider console to a pure listing"
```

---

### Task 4: `renderService` gains owner controls

**Files:**
- Modify: `web/src/lit-app.js`
- Test: `web/src/marketplace.test.js`

**Interfaces:**
- Consumes: `writeAuthorization` from Task 3.
- `renderService(services, slug, go)` keeps its signature and caller unchanged.

- [ ] **Step 1: Write the failing tests**

In `web/src/marketplace.test.js`, add a new `describe` block after `describe('the provider view', ...)` and its "add a service" successor (i.e. after the block Task 3 added), reusing the existing `PROVIDER` constant and the `wallet` mock:

```js
// The rendering half of the pair main.js's providerAuthorization mounts
// against (Task 7): a section without a mount behind it is a dead control, a
// mount with no section around it is invisible. These four cases are the
// same four resolveProviderConsole's replacement in lit-app.js distinguishes,
// now asked of a single service rather than a whole console.
describe('who gets a service page’s write controls', () => {
  const build = async () =>
    loadMarketplace(deps({ services: [service('weather', HONEST)], verdicts: [], records: { weather: record({}) } }));
  /** @param {any} account @param {any} session */
  const as = (account, session) => { wallet.account = account; wallet.session = session; };
  const signedIn = { address: PROVIDER, expiresAt: Date.now() + 60_000 };
  const controls = ['sla-editor-mount', 'bond-controls-mount'];
  /** @param {string} html */
  const present = (html) => controls.filter((id) => html.includes(id));

  afterEach(() => as(null, null));

  it('gives them to the owner, connected on a supported chain and signed in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, signedIn);
    const html = renderApp(await build(), 'live', 'service', 'weather');
    expect(present(html)).toEqual(controls);
  });
  it('withholds them from the owner until they sign in', async () => {
    as({ address: PROVIDER, chainId: ARC.chainId }, null);
    const html = renderApp(await build(), 'live', 'service', 'weather');
    expect(present(html)).toEqual([]);
    expect(html).toContain('Enable provider actions');
  });
  it('withholds them on an unsupported chain, and says which way out', async () => {
    as({ address: PROVIDER, chainId: 1 }, signedIn);
    const html = renderApp(await build(), 'live', 'service', 'weather');
    expect(present(html)).toEqual([]);
    expect(html).toContain('Switch network');
  });
  it('withholds them from a signed-in wallet viewing somebody else’s service', async () => {
    const other = '0xB0b0000000000000000000000000000000000002';
    as({ address: other, chainId: ARC.chainId }, { address: other, expiresAt: Date.now() + 60_000 });
    const html = renderApp(await build(), 'live', 'service', 'weather');
    expect(present(html)).toEqual([]);
    expect(html).not.toContain('Enable provider actions');
  });
  it('shows no write section at all to an unconnected visitor', async () => {
    const html = renderApp(await build(), 'demo', 'service', 'weather');
    expect(present(html)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web vitest run src/marketplace.test.js`
Expected: FAIL — `renderService` renders neither mount today, so `present(html)` is `[]` in every case, including the "gives them to the owner" one that expects both.

- [ ] **Step 3: Implement**

In `web/src/lit-app.js`, replace `renderService`:

```js
  /** @param {Listing[]} services @param {string} slug @param {(path: string) => void} go */
  renderService(services, slug, go) {
    const listing = services.find((service) => service.slug === slug) ?? null;
    const back = html`<p class="back"><a href=${MARKETPLACE_PATH} @click=${navigateOnClick(go, MARKETPLACE_PATH)}>← back to the marketplace</a></p>`;
    if (!listing) return html`${back}<p class="empty">No service found for “${slug}”.</p>`;
    const auth = this.writeAuthorization(listing.provider);
    return html`${back}${this.mode === 'demo' ? html`<p class="aside warn">Showing seeded data, not a live chain. Set <code>VITE_ARC_RPC_URL</code> to read Arc directly.</p>` : nothing}${detailTemplate(listing)}
      ${auth.ownPage && (!auth.signedIn || !auth.supported) ? html`<div class="aside"><p>${auth.signedIn ? 'Switch to a supported network to manage this service.' : 'Sign in once to manage your services. Your sign-in lasts 24 hours in this browser.'}</p><wa-button size="s" appearance="outlined" ?disabled=${this.signInPending} ?loading=${this.signInPending} @click=${this.signIn}>${auth.signedIn ? 'Switch network' : 'Enable provider actions'}</wa-button>${this.signInError ? html`<p role="status">${this.signInError}</p>` : nothing}</div>` : nothing}
      ${auth.canWrite ? html`
        <section class="editor block"><h3>SLA editor <small>${listing.name}</small></h3><p class="aside">Validated against the same <code>schema.json</code> the verifier enforces. Sent from your own wallet; Verdikt holds no key of yours.</p><verdikt-sla-editor id="sla-editor-mount"></verdikt-sla-editor></section>
        <section class="block"><h3>Bond <small>${listing.name}</small></h3><verdikt-bond-controls id="bond-controls-mount"></verdikt-bond-controls></section>` : nothing}`;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web vitest run src/marketplace.test.js`
Expected: the new `describe('who gets a service page's write controls', ...)` block PASSES in full. (The old provider-write-controls block is still failing — unchanged from Task 3, resolved in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add web/src/lit-app.js web/src/marketplace.test.js
git commit -m "Move SLA and bond management onto the service page"
```

---

### Task 5: `renderRegister` and the `/register` dispatch

**Files:**
- Modify: `web/src/lit-app.js`
- Test: `web/src/marketplace.test.js`

**Interfaces:**
- Consumes: `writeAuthorization`, `REGISTER_PATH`/`PROVIDER_PATH` (already imported by Task 3).
- Produces: `VerdiktApp.prototype.renderRegister(go)`, and `render()` handles `this.route.view === 'register'` before the `!this.marketplace` guard — the same tier as `landing`/`terms`/`privacy`, so a dead RPC or an unloaded marketplace never blocks reaching it.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/marketplace.test.js`, after the `describe('who gets a service page's write controls', ...)` block from Task 4:

```js
describe('the registration page', () => {
  /** @param {any} account */
  const as = (account) => { wallet.account = account; };

  afterEach(() => as(null));

  it('renders with no marketplace loaded at all', () => {
    expect(renderApp(null, 'live', 'register', null)).toContain('List a service');
  });

  it('prompts a visitor with no wallet connected to connect one', () => {
    const html = renderApp(null, 'live', 'register', null);
    expect(html).toContain('Connect a wallet');
    expect(html).not.toContain('wizard-mount');
  });

  it('prompts a connected but unsigned wallet to sign in, not the wizard', () => {
    as({ address: '0xA11ce00000000000000000000000000000000001', chainId: ARC.chainId });
    const html = renderApp(null, 'live', 'register', null);
    expect(html).toContain('Enable provider actions');
    expect(html).not.toContain('wizard-mount');
  });

  it('mounts the wizard for a signed-in, supported-chain wallet', () => {
    as({ address: '0xA11ce00000000000000000000000000000000001', chainId: ARC.chainId });
    wallet.session = { address: '0xA11ce00000000000000000000000000000000001', expiresAt: Date.now() + 60_000 };
    const html = renderApp(null, 'live', 'register', null);
    expect(html).toContain('wizard-mount');
    wallet.session = null;
  });

  it('shows a demo-mode notice instead of a wallet prompt', () => {
    const html = renderApp(null, 'demo', 'register', null);
    expect(html).toContain('List a service');
    expect(html).not.toContain('wizard-mount');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web vitest run src/marketplace.test.js`
Expected: FAIL — `render()` has no `register` branch, so `renderApp(..., 'register', ...)` falls through to `renderMarketplace` (since `route.view` isn't `'how'`/`'service'`/`'provider'`) and none of these strings appear.

- [ ] **Step 3: Implement**

In `web/src/lit-app.js`, add `renderRegister` next to `renderProvider`/`renderService`:

```js
  /** @param {(path: string) => void} go */
  renderRegister(go) {
    const account = getConnectedAccount();
    const auth = this.writeAuthorization(account?.address ?? null);
    const consoleUrl = account ? providerUrl(account.address) : PROVIDER_PATH;
    return html`${pageHead('List a service', 'Claim the ENS subname, register the bond and publish the SLA that calls will be judged against.')}
      ${this.mode !== 'live' ? html`<p class="aside warn">Registration needs a live chain. This build is showing seeded demo data.</p>` : nothing}
      <section class="block">
        ${!account
          ? html`<p>Connect a wallet to register a service.${this.mode === 'live' ? '' : ' Provider consoles read Arc Testnet; this build is showing seeded demo data.'}</p>${this.mode === 'live' ? html`<wa-button type="button" appearance="outlined" size="s" @click=${this.connect}>Connect wallet</wa-button>` : nothing}`
          : !auth.canWrite
            ? html`<p>${auth.signedIn ? 'Switch to a supported network to register a service.' : 'Sign in once to register a service. Your sign-in lasts 24 hours in this browser.'}</p><wa-button size="s" appearance="outlined" ?disabled=${this.signInPending} ?loading=${this.signInPending} @click=${this.signIn}>${auth.signedIn ? 'Switch network' : 'Enable provider actions'}</wa-button>${this.signInError ? html`<p role="status">${this.signInError}</p>` : nothing}`
            : html`<verdikt-wizard id="wizard-mount"></verdikt-wizard>`}
      </section>
      <p class="back"><a href=${consoleUrl} @click=${navigateOnClick(go, consoleUrl)}>← back to your console</a></p>`;
  }
```

In `render()`, add the register branch right after the address-less-provider branch and before `if (this.error)`:

```js
    // /register needs no listing to be itself — like landing/terms/privacy,
    // it must survive a dead RPC or a marketplace still in flight.
    if (this.route.view === 'register') {
      return html`${navBar}${this.renderRegister(go)}${legalFooter(go)}`;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web vitest run src/marketplace.test.js`
Expected: the new `describe('the registration page', ...)` block PASSES.

- [ ] **Step 5: Commit**

```bash
git add web/src/lit-app.js web/src/marketplace.test.js
git commit -m "Add the /register page"
```

---

### Task 6: Retire the old combined write-controls test, verify the full render suite

**Files:**
- Modify: `web/src/marketplace.test.js`

**Interfaces:**
- None — this task only removes tests made redundant by Tasks 3–5 and confirms the whole file is green.

- [ ] **Step 1: Delete the superseded block**

Delete the entire `describe('who gets the provider console's write controls', ...)` block from `web/src/marketplace.test.js` (the one asserting `wizard-mount`/`sla-editor-mount`/`bond-controls-mount` together against a `'provider'` render — its four cases now live as `describe('who gets a service page's write controls', ...)` (Task 4, sla/bond) and `describe('the registration page', ...)` (Task 5, wizard)). Its leading comment block goes with it.

- [ ] **Step 2: Run the full file**

Run: `pnpm --filter web vitest run src/marketplace.test.js`
Expected: PASS, every test in the file.

- [ ] **Step 3: Commit**

```bash
git add web/src/marketplace.test.js
git commit -m "Remove the provider-console write-controls test superseded by the service and register pages"
```

---

### Task 7: `main.js` mounts by route, not by page

**Files:**
- Modify: `web/src/main.js`
- Test: `web/src/main.test.js`

**Interfaces:**
- Consumes: `route.view` values `'service'` | `'register'` | `'provider'` from `parseRoute` (Task 1 added `'register'`; `'service'` and `'provider'` already existed).
- Produces: `providerAuthorization(marketplace, route)` returns `{ account, target, canWrite }` where `target` is the listing matching `route.slug` on a `service` route and `null` everywhere else. `mountProviderConsole(route)` mounts `#wizard-mount` only for `route.view === 'register'`, and `#sla-editor-mount`/`#bond-controls-mount` only for `route.view === 'service'` with a resolved `target`.

- [ ] **Step 1: Write the failing tests**

Replace `web/src/main.test.js` in full with:

```js
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise the application coordinator with inert view elements. Wallet and
// SIWE adapters have their own provider/signature tests; here we verify that
// their events revoke and restore the actual form dependencies, now split
// across the wizard on /register and the SLA/bond controls on /services/<slug>.
const state = vi.hoisted(() => ({
  account: /** @type {any} */ (null), session: /** @type {any} */ (null),
  changed: /** @type {any} */ (null), signIn: vi.fn(), ensureChain: vi.fn(),
  connectWallet: vi.fn(), disconnectWallet: vi.fn(), restoreWallet: vi.fn()
}));
const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
vi.mock('@verdikt/sdk', () => ({ ARC: { chainId: 5042002, registry: 'registry' }, SEPOLIA: { chainId: 11155111, subnameRegistrar: 'registrar' }, registryAbi: [] }));
vi.mock('./wallet.js', () => ({
  getConnectedAccount: () => state.account,
  onAccountChange: (/** @type {Function} */ fn) => { state.changed = fn; },
  connectWallet: state.connectWallet,
  disconnectWallet: state.disconnectWallet,
  restoreWallet: state.restoreWallet,
  ensureChain: state.ensureChain,
  walletClientFor: vi.fn(() => ({}))
}));
vi.mock('./session.js', () => ({ getSession: () => state.session, signIn: state.signIn }));
vi.mock('./source.js', () => ({ createSource: () => ({ mode: 'live', deps: { registry: { client: { readContract: async () => 1n } } } }) }));
vi.mock('./marketplace.js', () => ({
  byReputation: () => 0,
  loadMarketplace: async () => ({
    services: [
      { provider: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', slug: 'weather' },
      { provider: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', slug: 'quotes' }
    ],
    stats: {}
  })
}));
vi.mock('./theme.js', () => ({ savedTheme: () => 'light', saveTheme: vi.fn() }));
vi.mock('./lit-app.js', () => ({}));
vi.mock('./forms/sla-editor.js', () => ({}));
vi.mock('./forms/bond.js', () => ({}));
vi.mock('./forms/wizard.js', () => ({}));
vi.mock('./forms/subscribe.js', () => ({}));
vi.mock('./forms/contact.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/styles/themes/default.css', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/button/button.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/button-group/button-group.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/dropdown/dropdown.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/divider/divider.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/input/input.js', () => ({}));
vi.mock('@awesome.me/webawesome/dist/components/textarea/textarea.js', () => ({}));

/** @type {any} */ let app;
/** @type {Record<string, any>} */ let controls;
/** @type {Map<string, Function>} */ let events;
/** @type {Map<string, Function>} */ let windowEvents;
/** @type {import('vitest').Mock} */ let pushState;
/** @type {import('vitest').Mock} */ let replaceState;
/** @type {import('vitest').Mock} */ let scrollTo;
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function authenticate() { state.session = { ...state.account, expiresAt: Date.now() + 60000 }; }
function change(address = OWNER, chainId = 11155111, identityChanged = true) {
  state.account = address ? { address, chainId } : null;
  if (identityChanged) state.session = null;
  state.changed(address || null, identityChanged);
}
/** @param {string} path */
async function go(path) {
  events.get('navigate')?.({ detail: path });
  await settle();
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  state.account = { address: OWNER, chainId: 11155111 }; authenticate();
  state.signIn.mockImplementation(async () => authenticate());
  state.connectWallet.mockImplementation(async () => state.account);
  state.restoreWallet.mockResolvedValue(undefined);
  state.disconnectWallet.mockImplementation(async () => change(''));
  state.ensureChain.mockImplementation(async chainId => change(OWNER, chainId, false));
  controls = Object.fromEntries(['sla-editor-mount', 'bond-controls-mount', 'wizard-mount'].map(id => [id, {
    deps: null, listing: null, draft: 'draft', step: 2,
    clear() { this.deps = null; this.listing = null; this.draft = ''; this.step = 1; }
  }]));
  events = new Map();
  windowEvents = new Map();
  app = { querySelector: (/** @type {string} */ selector) => controls[selector.slice(1)], updateComplete: Promise.resolve(), addEventListener: (/** @type {string} */ name, /** @type {Function} */ fn) => events.set(name, fn) };
  vi.stubGlobal('document', { getElementById: () => ({ append: vi.fn() }), createElement: () => app });
  vi.stubGlobal('location', new URL(`https://verdikt.example/?provider=${OWNER}`));
  pushState = vi.fn();
  replaceState = vi.fn();
  scrollTo = vi.fn();
  vi.stubGlobal('history', { replaceState, pushState });
  vi.stubGlobal('window', { addEventListener: (/** @type {string} */ name, /** @type {Function} */ listener) => windowEvents.set(name, listener), scrollTo });
  await import('./main.js'); await settle();
});
afterEach(() => vi.unstubAllGlobals());

it('mounts the wizard, not the sla/bond controls, on /register for the signed-in owner', async () => {
  await go('/register');
  expect(controls['wizard-mount'].deps.account).toBe(OWNER);
  expect(controls['sla-editor-mount'].deps).toBeNull();
  expect(controls['bond-controls-mount'].deps).toBeNull();
});
it('mounts the sla/bond controls, not the wizard, on the owner’s own service page', async () => {
  await go('/services/weather');
  expect(controls['sla-editor-mount'].deps).not.toBeNull();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
  expect(controls['wizard-mount'].deps).toBeNull();
});
it('mounts nothing on a service owned by someone else', async () => {
  await go('/services/quotes');
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('mounts nothing on a service that does not exist', async () => {
  await go('/services/nonexistent');
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('mounts nothing on the provider console, a valid address or none', async () => {
  await go(`/provider/${OWNER}`);
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  await go('/provider');
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('starts wallet restoration on load without requesting connection or sign-in', () => {
  expect(state.restoreWallet).toHaveBeenCalledOnce();
  expect(state.connectWallet).not.toHaveBeenCalled();
  expect(state.signIn).not.toHaveBeenCalled();
});
it('immediately removes stale controls when a different account views the owner-only service page', async () => {
  await go('/services/weather');
  change(OTHER);
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('resets the wizard’s step when a different account activates /register', async () => {
  await go('/register');
  change(OTHER);
  expect(controls['wizard-mount'].step).toBe(1);
});
it('revokes all provider controls on disconnect', async () => {
  await go('/services/weather');
  await events.get('wallet-disconnect')?.(); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('suspends controls on an external chain change without losing drafts', async () => {
  await go('/services/weather');
  change(OWNER, 1, false); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
  expect(controls['sla-editor-mount'].draft).toBe('draft');
});
it('reuses authentication after switching to Arc and restores its dependencies', async () => {
  await go('/services/weather');
  const ensureArc = controls['bond-controls-mount'].deps.ensureArc;
  await ensureArc();
  expect(state.ensureChain).toHaveBeenCalledWith(5042002, expect.objectContaining({ chainId: 5042002 }));
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
  // A same-identity chain switch nulls deps but never calls .clear() — the
  // wizard's own step (irrelevant to this page) is left exactly as it was.
  expect(controls['wizard-mount'].step).toBe(2);
});
it('does not restore controls when re-authentication is rejected', async () => {
  await go('/services/weather');
  state.signIn.mockRejectedValueOnce(new Error('user rejected'));
  const ensureArc = controls['bond-controls-mount'].deps.ensureArc;
  state.session = null;
  await expect(ensureArc()).rejects.toThrow('user rejected'); await settle();
  for (const control of Object.values(controls)) expect(control.deps).toBeNull();
});
it('connects on an unsupported network without requesting a signature or network switch', async () => {
  await go('/services/weather');
  change(OWNER, 1, false); await settle();
  await events.get('wallet-connect')?.(); await settle();
  expect(state.ensureChain).not.toHaveBeenCalled();
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).toBeNull();
});
it('recovers from an unsupported network on explicit provider activation without re-signing', async () => {
  await go('/services/weather');
  change(OWNER, 1, false); await settle();
  await events.get('provider-sign-in')?.(); await settle();
  expect(state.ensureChain).toHaveBeenCalledWith(11155111, expect.objectContaining({ chainId: 11155111 }));
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
});
it('requires an explicit provider sign-in after connecting without a saved session', async () => {
  await go('/services/weather');
  change(); await settle();
  await events.get('wallet-connect')?.(); await settle();
  expect(state.signIn).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).toBeNull();
  await events.get('provider-sign-in')?.(); await settle();
  expect(state.signIn).toHaveBeenCalledOnce();
  expect(controls['bond-controls-mount'].deps).not.toBeNull();
});
it('reports a rejected provider sign-in without reconnecting or enabling actions', async () => {
  await go('/services/weather');
  change(); await settle();
  state.signIn.mockRejectedValueOnce(new Error('user rejected'));
  await events.get('provider-sign-in')?.(); await settle();
  expect(app.signInError).toContain('not completed');
  expect(app.signInPending).toBe(false);
  expect(state.connectWallet).not.toHaveBeenCalled();
  expect(controls['bond-controls-mount'].deps).toBeNull();
});
it('rewrites a legacy ?provider= deep link to the canonical path on load', () => {
  expect(replaceState).toHaveBeenCalledWith(null, '', `/provider/${OWNER}`);
});
it('navigates to the provider console after an explicit wallet connect', async () => {
  await events.get('wallet-connect')?.(); await settle();
  expect(pushState).toHaveBeenCalledWith(null, '', `/provider/${OWNER}`);
});
it('does not push a redundant history entry when reconnecting the same provider wallet', async () => {
  vi.stubGlobal('location', new URL(`https://verdikt.example/provider/${OWNER}`));
  pushState.mockClear();
  await events.get('wallet-connect')?.(); await settle();
  expect(pushState).not.toHaveBeenCalled();
});
it('scrolls to the new page heading after Lit renders a forward navigation', async () => {
  events.get('navigate')?.({ detail: '/terms' });
  expect(scrollTo).not.toHaveBeenCalled();
  await settle();
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
});
it('leaves scroll restoration to the browser for back and forward history', async () => {
  windowEvents.get('popstate')?.();
  await settle();
  expect(scrollTo).not.toHaveBeenCalled();
});
it('does not navigate to the provider console on a silent wallet restoration', async () => {
  change(OTHER);
  await settle();
  expect(pushState).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web vitest run src/main.test.js`
Expected: FAIL — today's `main.js` mounts the wizard on `/provider/<addr>` (not `/register`) and the SLA/bond controls the same way regardless of `route.view`, so the new route-specific assertions (`mounts the wizard, not the sla/bond controls, on /register…`, `mounts nothing on a service owned by someone else`, `mounts nothing on the provider console…`, etc.) fail.

- [ ] **Step 3: Implement**

In `web/src/main.js`, replace `providerAuthorization`:

```js
/**
 * Whether the connected wallet may write on the console currently on screen,
 * and which listing its controls act on. This is the mount-side half of
 * `writeAuthorization` in lit-app.js — the two must agree, or a section
 * renders without a mount behind it (a dead control) or a mount appears with
 * no section around it (an invisible one). `target` only exists on a
 * `service` route: `register` acts on the connected wallet directly, and
 * `provider` mounts nothing at all any more.
 * @param {Marketplace} marketplace
 * @param {ReturnType<typeof parseRoute>} route
 */
function providerAuthorization(marketplace, route) {
  const account = getConnectedAccount();
  const session = getSession();
  const target = route.view === 'service' ? marketplace.services.find((listing) => listing.slug === route.slug) ?? null : null;
  const providerAddress = route.view === 'service' ? (target?.provider ?? null) : (account?.address ?? null);
  const ownPage = Boolean(account && providerAddress && account.address.toLowerCase() === providerAddress.toLowerCase());
  const sessionMatchesAccount = Boolean(account && session && session.address.toLowerCase() === account.address.toLowerCase() && [ARC.chainId, SEPOLIA.chainId].includes(account.chainId));
  return { account, target, canWrite: ownPage && sessionMatchesAccount };
}
```

Replace `mountProviderConsole`:

```js
/**
 * @param {ReturnType<typeof parseRoute>} route
 */
function mountProviderConsole(route) {
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const { account, target, canWrite } = providerAuthorization(marketplace, route);
  // Set in main() before draw() is ever called in live mode — see the guard
  // in main() above. Not null here.
  const depositAmount = /** @type {bigint} */ (depositAmountCache);
  const wizardMount = /** @type {import('./forms/wizard.js').VerdiktWizard|null} */ (app.querySelector('#wizard-mount'));
  if (wizardMount) {
    if (route.view === 'register' && account && canWrite) {
      if (SEPOLIA.subnameRegistrar) {
        wizardMount.message = '';
        wizardMount.deps = {
          account: account.address,
          registrarAddress: SEPOLIA.subnameRegistrar,
          registryAddress: /** @type {string} */ (ARC.registry),
          depositAmount,
          sepoliaRpcUrl: SEPOLIA_CHAIN_CONFIG.rpcUrl,
          formatNativeUsdc,
          walletClientFor: (chain) => walletClientFor(chain === 'arc' ? ARC_CHAIN_CONFIG : SEPOLIA_CHAIN_CONFIG),
          ensureSepolia: () => ensureSignedChain(SEPOLIA_CHAIN_CONFIG),
          ensureArc: () => ensureSignedChain(ARC_CHAIN_CONFIG),
          onDone: () => main()
        };
      } else {
        // A build-configuration fact, not an authorization one: this renders
        // on a page whose owner is signed in and may otherwise write.
        wizardMount.message = 'Service onboarding needs the subname registrar deployed — not yet live on this build.';
      }
    } else {
      wizardMount.deps = null;
    }
  }
  const slaMount = /** @type {import('./forms/sla-editor.js').VerdiktSlaEditor|null} */ (app.querySelector('#sla-editor-mount'));
  const bondMount = /** @type {import('./forms/bond.js').VerdiktBondControls|null} */ (app.querySelector('#bond-controls-mount'));
  // Off the service route, or a service route with no resolved listing (a
  // slug nobody owns), there is nothing for these two to act on — clear
  // rather than merely null, which also drops a stale draft.
  if (route.view !== 'service' || !target) {
    slaMount?.clear();
    bondMount?.clear();
    return;
  }
  if (slaMount && canWrite) {
    slaMount.message = '';
    slaMount.listing = target;
    slaMount.deps = {
      walletClientFor: () => walletClientFor(SEPOLIA_CHAIN_CONFIG),
      ensureSepolia: () => ensureSignedChain(SEPOLIA_CHAIN_CONFIG)
    };
  } else if (slaMount) {
    slaMount.deps = null;
  }
  if (bondMount && canWrite) {
    bondMount.message = '';
    bondMount.listing = target;
    bondMount.deps = {
      walletClientFor: () => walletClientFor(ARC_CHAIN_CONFIG),
      registryAddress: /** @type {string} */ (ARC.registry),
      depositAmount,
      formatNativeUsdc,
      ensureArc: () => ensureSignedChain(ARC_CHAIN_CONFIG)
    };
  } else if (bondMount) {
    bondMount.deps = null;
  }
}
```

Replace `draw`'s mounting-related lines (keep the function's shape, only the two `route.view === 'provider'` conditions change):

```js
/** @param {{ scrollToTop?: boolean }} [options] */
function draw(options = {}) {
  const route = syncRoute();
  app.mode = mode;
  app.theme = savedTheme();
  app.route = route;
  if (!marketplaceCache) return;
  const marketplace = /** @type {Marketplace} */ (marketplaceCache);
  const managesControls = mode === 'live' && (route.view === 'service' || route.view === 'register');
  // `verdikt-app` is patched asynchronously by Lit. Clear the currently
  // mounted controls before that patch removes them, otherwise a wallet that
  // owns no services — or one looking at somebody else's service, where the
  // controls are not rendered at all — can retain the prior provider's
  // listing and dependencies.
  if (managesControls) {
    const { canWrite, target } = providerAuthorization(marketplace, route);
    if (!canWrite || (route.view === 'service' && !target)) clearProviderControls(false);
  }
  app.marketplace = marketplace;
  if (managesControls) {
    app.updateComplete.then(() => mountProviderConsole(route));
  }
  // History navigation owns restoration for popstate. Only a newly pushed
  // route starts at its heading, and only once Lit has put that heading in DOM.
  if (options.scrollToTop) app.updateComplete.then(() => window.scrollTo(0, 0));
}
```

`clearProviderControls`, `onAccountChange`, `signInConnected`, `ensureSignedChain`, and every event listener are unchanged — they already operate on whichever mounts exist in the DOM (`querySelector` returning `null` off-route) and don't reference `route.view` themselves.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web vitest run src/main.test.js`
Expected: PASS, every test in the file.

- [ ] **Step 5: Commit**

```bash
git add web/src/main.js web/src/main.test.js
git commit -m "Mount the wizard and SLA/bond controls by route, not by provider page"
```

---

### Task 8: The registration wizard collects, then signs

**Files:**
- Modify: `web/src/forms/wizard.js`
- Modify: `web/src/styles.css`
- Test: `web/src/forms/wizard.test.js` (new)

**Interfaces:**
- Consumes: `describeSlaValidity` from `web/src/forms/sla-editor.js` (already exported — Task-3-4-5 untouched); `claimSubname`, `registerService`, `publishUrl`, `publishSla` from `web/src/actions.js` (unchanged signatures).
- Produces: `buildExecutionSteps(deps, { slug, url, sla }) → Array<{ key: string, label: string, chain: 'Sepolia'|'Arc', ensure: () => Promise<void>, run: () => Promise<{hash: string}> }>`, exported for direct testing. `VerdiktWizard` keeps its `deps`/`message` external contract (set by `main.js`'s `mountProviderConsole`, Task 7) but its internal state becomes `step` (1–4), `slug`/`availability`/`available` (step 1), `url` (step 2), `sla` (step 3), `done` (0–4, the execution cursor), `execError`, `pending`, `status`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/forms/wizard.test.js`:

```js
import { describe, expect, it, vi } from 'vitest';
import { buildExecutionSteps } from './wizard.js';

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

describe('the wizard element', () => {
  /** @returns {any} */
  const mount = () => {
    const el = /** @type {any} */ (document.createElement('verdikt-wizard'));
    document.body.append(el);
    return el;
  };

  it('starts on step 1 with the deposit and no wallet activity', () => {
    const el = mount();
    expect(el.step).toBe(1);
    expect(el.done).toBe(0);
  });

  it('runs the four steps in order and reports done', async () => {
    const claim = vi.fn(async () => '0xhash');
    const register = vi.fn(async () => '0xhash');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web vitest run src/forms/wizard.test.js`
Expected: FAIL — `buildExecutionSteps` doesn't exist yet (today's `wizard.js` exports nothing beyond the custom element), and `el.execute`/`el.done`/`el.execError` don't exist on the current 3-step element.

- [ ] **Step 3: Implement**

Replace `web/src/forms/wizard.js` in full:

```js
// New-service onboarding: ENS is claimed before Arc registration, so a newly
// registered service can never begin life with conflicting ownership.
//
// Steps 1-3 are pure form state — no wallet involved, Back/Next only. Step 4
// reviews the draft and, on confirmation, runs the four transactions above
// in that fixed order from a resumable cursor (`done`): a step that fails
// leaves `done` where it stopped, and Retry resumes from there rather than
// from the top — a claimed subname is never re-claimed.
import { LitElement, html, nothing } from 'lit';
import { resolveServiceRecord } from '@verdikt/sdk';
import { claimSubname, publishSla, publishUrl, registerService } from '../actions.js';
import { describeSlaValidity } from './sla-editor.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The four transactions registration requires, in the order the module
 * comment above mandates. A pure builder so it's testable without mounting
 * the element: `run()` closures capture `deps` and the draft, nothing else.
 * @param {NonNullable<VerdiktWizard['deps']>} deps
 * @param {{ slug: string, url: string, sla: string }} draft
 */
export function buildExecutionSteps(deps, { slug, url, sla }) {
  return [
    {
      key: 'claim', label: `Claim ${slug}.verdikt.eth`, chain: /** @type {const} */ ('Sepolia'),
      ensure: deps.ensureSepolia,
      run: () => claimSubname({ walletClient: deps.walletClientFor('sepolia'), registrarAddress: deps.registrarAddress, slug, payTo: deps.account })
    },
    {
      key: 'register', label: `Register on Arc · ${deps.formatNativeUsdc(deps.depositAmount)}`, chain: /** @type {const} */ ('Arc'),
      ensure: deps.ensureArc,
      run: () => registerService({ walletClient: deps.walletClientFor('arc'), registryAddress: deps.registryAddress, slug, depositAmount: deps.depositAmount })
    },
    {
      key: 'url', label: 'Publish endpoint URL', chain: /** @type {const} */ ('Sepolia'),
      ensure: deps.ensureSepolia,
      run: () => publishUrl({ walletClient: deps.walletClientFor('sepolia'), slug, value: url.trim() })
    },
    {
      key: 'sla', label: 'Publish SLA', chain: /** @type {const} */ ('Sepolia'),
      ensure: deps.ensureSepolia,
      run: () => publishSla({ walletClient: deps.walletClientFor('sepolia'), slug, value: sla.trim() })
    }
  ];
}

export class VerdiktWizard extends LitElement {
  static properties = {
    deps: { attribute: false }, message: {}, step: { state: true }, slug: { state: true },
    availability: { state: true }, available: { state: true }, url: { state: true }, sla: { state: true },
    done: { state: true }, execError: { state: true }, pending: { state: true }, status: { state: true }
  };
  constructor() {
    super();
    /** @type {{account:string, registrarAddress:string, registryAddress:string, depositAmount:bigint, sepoliaRpcUrl:string, formatNativeUsdc:(v:bigint)=>string, walletClientFor:(chain:'arc'|'sepolia')=>{writeContract:Function,sendTransaction:Function}, ensureSepolia:()=>Promise<void>, ensureArc:()=>Promise<void>, onDone:()=>void}|null} */ this.deps = null;
    this.message = ''; this.step = 1; this.slug = ''; this.availability = ''; this.available = false;
    this.url = ''; this.sla = ''; this.done = 0; this.execError = ''; this.pending = false; this.status = '';
    this.checkToken = 0;
  }
  createRenderRoot() { return this; }
  clear() {
    this.deps = null;
    this.checkToken++;
    this.message = ''; this.step = 1; this.slug = ''; this.availability = ''; this.available = false;
    this.url = ''; this.sla = ''; this.done = 0; this.execError = ''; this.pending = false; this.status = '';
  }
  /** @param {number} step */
  goStep(step) { this.step = step; }
  /** @param {InputEvent} event */
  editSlug(event) {
    this.slug = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value.trim();
    this.checkAvailability();
  }
  async checkAvailability() {
    const token = ++this.checkToken;
    this.available = false;
    if (!SLUG.test(this.slug)) { this.availability = 'Lowercase letters, digits and hyphens only.'; return; }
    this.availability = 'Checking…';
    try {
      const record = await resolveServiceRecord(this.slug, { rpcUrl: /** @type {NonNullable<typeof this.deps>} */ (this.deps).sepoliaRpcUrl });
      if (token !== this.checkToken) return;
      this.available = !record.owner;
      this.availability = record.owner ? `Already claimed by ${record.owner}.` : 'Available.';
    } catch (error) {
      if (token !== this.checkToken) return;
      this.availability = `Could not check availability: ${/** @type {Error} */ (error).message}`;
    }
  }
  /** @param {InputEvent} event */ editUrl(event) { this.url = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
  /** @param {InputEvent} event */ editSla(event) { this.sla = /** @type {{value:string}} */ (/** @type {unknown} */ (event.currentTarget)).value; }
  get urlValid() { return /^https?:\/\//.test(this.url.trim()); }
  async execute() {
    const deps = this.deps;
    if (!deps) return;
    const steps = buildExecutionSteps(deps, { slug: this.slug, url: this.url, sla: this.sla });
    this.pending = true;
    this.execError = '';
    for (let i = this.done; i < steps.length; i++) {
      this.status = `${i + 1}/${steps.length} ${steps[i].label}…`;
      try {
        await steps[i].ensure();
        await steps[i].run();
        this.done = i + 1;
      } catch (error) {
        this.pending = false;
        this.execError = /** @type {Error} */ (error).message;
        this.status = '';
        return;
      }
    }
    this.pending = false;
    this.status = 'Done.';
    deps.onDone();
  }
  renderStep() {
    if (this.step === 1) return html`
      <wa-input id="wizard-slug" label="Slug" autocomplete="off" .value=${this.slug} placeholder="weather" @input=${this.editSlug}></wa-input>
      ${this.availability ? html`<p class="form-status" id="wizard-availability">${this.availability}</p>` : nothing}
      <div class="wizard-nav"><wa-button type="button" id="wizard-next-1" ?disabled=${!this.available} @click=${() => this.goStep(2)}>Next</wa-button></div>`;
    if (this.step === 2) return html`
      <wa-input id="wizard-url" label="Endpoint URL" type="url" autocomplete="off" placeholder="https://provider.example/api" .value=${this.url} @input=${this.editUrl}></wa-input>
      <div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.goStep(1)}>Back</wa-button><wa-button type="button" id="wizard-next-2" ?disabled=${!this.urlValid} @click=${() => this.goStep(3)}>Next</wa-button></div>`;
    if (this.step === 3) {
      const validity = describeSlaValidity(this.sla);
      return html`
        <wa-textarea id="wizard-sla" label="SLA (JSON)" spellcheck="false" rows="10" resize="vertical" .value=${this.sla} @input=${this.editSla}></wa-textarea>
        <p class="check ${validity.ok ? 'ok' : 'bad'}" id="wizard-sla-check"><i class="dot"></i>${validity.message}</p>
        <div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.goStep(2)}>Back</wa-button><wa-button type="button" id="wizard-next-3" ?disabled=${!validity.ok} @click=${() => this.goStep(4)}>Next</wa-button></div>`;
    }
    return this.renderReview();
  }
  renderReview() {
    const deps = /** @type {NonNullable<typeof this.deps>} */ (this.deps);
    const steps = buildExecutionSteps(deps, { slug: this.slug, url: this.url, sla: this.sla });
    return html`
      <dl class="wizard-review">
        <div><dt>Slug</dt><dd>${this.slug}.verdikt.eth</dd></div>
        <div><dt>Endpoint</dt><dd>${this.url.trim()}</dd></div>
        <div><dt>SLA</dt><dd>${describeSlaValidity(this.sla).message}</dd></div>
        <div><dt>Bond</dt><dd>${deps.formatNativeUsdc(deps.depositAmount)}</dd></div>
      </dl>
      ${this.done === 0 ? html`<div class="wizard-nav"><wa-button type="button" appearance="outlined" @click=${() => this.goStep(3)}>Back</wa-button><wa-button type="button" id="wizard-register" ?disabled=${this.pending} ?loading=${this.pending} @click=${this.execute}>Register service</wa-button></div>` : nothing}
      <ol class="wizard-progress">${steps.map((step, i) => html`<li class=${i < this.done ? 'done' : i === this.done && this.execError ? 'error' : ''}>${i + 1}/${steps.length} ${step.label} <small>${step.chain}</small></li>`)}</ol>
      ${this.execError ? html`<p class="form-status" id="wizard-status">Failed: ${this.execError}</p><wa-button type="button" id="wizard-retry" ?disabled=${this.pending} ?loading=${this.pending} @click=${this.execute}>Retry</wa-button>` : this.status ? html`<p class="form-status" id="wizard-status">${this.status}</p>` : nothing}`;
  }
  render() {
    if (this.message) return html`<p class="aside">${this.message}</p>`;
    if (!this.deps) return nothing;
    return html`<ol class="wizard-steps">
        <li class=${this.step >= 1 ? 'done' : ''}>1. Name</li>
        <li class=${this.step >= 2 ? 'done' : ''}>2. Endpoint</li>
        <li class=${this.step >= 3 ? 'done' : ''}>3. SLA</li>
        <li class=${this.step >= 4 ? 'done' : ''}>4. Review</li>
      </ol>${this.renderStep()}`;
  }
}

if (!customElements.get('verdikt-wizard')) customElements.define('verdikt-wizard', VerdiktWizard);
```

In `web/src/styles.css`, replace the `/* Onboarding wizard */` section at the end of the file:

```css
/* Onboarding wizard ------------------------------------------------------------ */

.wizard-steps { display: flex; gap: 24px; list-style: none; padding: 0; margin: 0 0 16px; font-size: 14.5px; color: var(--muted); }
.wizard-steps li.done { color: var(--good); font-weight: 500; }
.wizard-nav { display: flex; gap: 12px; margin-top: 18px; }
.wizard-nav wa-button { margin-top: 0; }
.wizard-review { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 18px; margin: 4px 0 20px; font-size: 15px; }
.wizard-review dt { color: var(--muted); }
.wizard-review dd { margin: 0; font-family: var(--mono); overflow-wrap: anywhere; }
.wizard-progress { list-style: none; padding: 0; margin: 8px 0 0; font-size: 14.5px; color: var(--muted); display: grid; gap: 4px; }
.wizard-progress li.done { color: var(--good); }
.wizard-progress li.error { color: var(--poor); }
.wizard-progress small { color: var(--muted); margin-left: 6px; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web vitest run src/forms/wizard.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/forms/wizard.js web/src/forms/wizard.test.js web/src/styles.css
git commit -m "Rewrite the registration wizard to collect input before it signs anything"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole web test suite**

Run: `pnpm --filter web test` (equivalently `pnpm --filter web vitest run`)
Expected: PASS, every test file — `router.test.js`, `landing.test.js`, `marketplace.test.js`, `main.test.js`, `forms/wizard.test.js`, and the untouched files (`provider.test.js`, `pages.test.js`, `actions.test.js`, `session.test.js`, `source.test.js`, `wallet.test.js`).

- [ ] **Step 2: Lint and typecheck**

Run: `pnpm lint`
Expected: no errors.

Run: `pnpm typecheck`
Expected: no errors. If `tsc` flags `VerdiktWizard`'s dropped `slaValidity` getter or removed `claim`/`register`/`publish` methods anywhere outside `wizard.js`/`wizard.test.js`, grep for their names (`grep -rn "slaValidity\|wizardMount.deps.account" web/src`) — nothing outside those two files should reference the old shape, since `main.js`'s wizard `deps` object is unchanged and neither `slaValidity` nor the three old methods were ever called from outside the element.

- [ ] **Step 3: Manual smoke check in the real app**

Use the `run-web` skill to start the dev server and drive it in a real browser (not just SSR strings):
1. `/marketplace` still lists services and links to `/services/<slug>`.
2. `/provider/<connected address>` shows only the listing, the figures, and — when signed in — a `+ add a service` link to `/register`.
3. `/register` with no wallet connected shows a connect prompt; connected-but-unsigned shows the sign-in aside; signed in on a supported chain shows the 4-step wizard.
4. Step through the wizard: slug availability gates step 1's Next, a malformed URL gates step 2's, an invalid SLA gates step 3's; step 4 shows a review and only then a `Register service` button.
5. `/services/<a service you own>` shows the public detail plus, when signed in as its owner, the SLA editor and bond sections.
6. `/services/<a service you don't own>` shows the public detail and nothing else.

Report any visual regression against `docs/walkthrough.md`'s existing screenshots before calling this task done.

- [ ] **Step 4: Commit** (only if Step 3 required fixes; otherwise this task produces no diff)

```bash
git add -A
git commit -m "Fix issues found in manual verification of the provider/register split"
```

---

## Self-review

**Spec coverage** — every section of `docs/superpowers/specs/2026-09-11-provider-listing-registration-wizard-design.md` maps to a task: §1 routing → Task 1; landing link → Task 2; §2 provider listing → Task 3; §3 service-page controls and §3.1 shared authorization → Tasks 3–4 (helper) and 4 (mount); §4.1–4.3 wizard sequencing/order/retry → Task 8; §4.4 cleanups (`describeSlaValidity` reuse, `deps` capture) → Task 8's implementation; §5 styles → Task 8; §6 test plan → Tasks 1–8's own Test sections plus Task 6's cleanup. §"Out of scope" items are left untouched by every task, as intended.

**Placeholder scan** — no task step describes what to do without showing the code; every Run line names its command and expected result.

**Type consistency** — `writeAuthorization`'s return shape (`ownPage`/`signedIn`/`supported`/`canWrite`) is identical across Tasks 3, 4 and 5. `providerAuthorization`'s return shape (`account`/`target`/`canWrite`) in Task 7 matches every existing caller in `main.js` untouched by this plan (`draw`, `mountProviderConsole`). `buildExecutionSteps`' descriptor shape (`key`/`label`/`chain`/`ensure`/`run`) is used identically in Task 8's implementation and its test. Mount ids (`#wizard-mount`, `#sla-editor-mount`, `#bond-controls-mount`) are unchanged from the current code throughout.
