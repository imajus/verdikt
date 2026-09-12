# System Theme Option Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `System` theme choice (alongside the existing `Light`/`Dark`) to the dashboard's nav theme control, tracking `prefers-color-scheme` live, while only persisting explicit Light/Dark overrides.

**Architecture:** Split `web/src/theme.js`'s single `Theme` concept into a persisted `Preference` (`'system'|'light'|'dark'`) and an applied `Theme` (`'light'|'dark'`). `main.js` resolves the preference to an effective theme on load, on toggle, and on OS-level `matchMedia` changes (only while the preference is `'system'`), applying it via the existing `applyTheme`. The nav's icon-only toggle button cycles `system → light → dark → system`.

**Tech Stack:** Vanilla JS (ESM), Lit (`lit-app.js`), Vitest, `@lit-labs/ssr` for template-string test assertions.

**Spec:** `docs/superpowers/specs/2026-09-12-system-theme-design.md`

## Global Constraints

- No TypeScript — JS with JSDoc, per project convention. Local `@typedef` blocks (not ambient `.d.ts`) for `Preference`/`Theme`, matching `theme.js`'s existing pattern.
- `pnpm vitest run <file>` to run a single test file; `pnpm lint` and `pnpm typecheck` must stay clean.
- No cross-tab sync, no change to the two theme colors (`#f6f4ee` / `#141310`), no change to `applyTheme`'s signature — all explicitly out of scope per the spec.

---

### Task 1: `theme.js` — Preference/Theme model, and the no-flash bootstrap

**Files:**
- Modify: `web/src/theme.js` (full rewrite of its exports)
- Modify: `web/index.html:65-71` (inline bootstrap script)
- Create: `web/src/theme.test.js`

**Interfaces:**
- Produces (consumed by Task 2 and Task 3):
  - `savedPreference(): Preference` where `Preference = 'system'|'light'|'dark'`
  - `systemTheme(): Theme` where `Theme = 'light'|'dark'`
  - `effectiveTheme(preference: Preference): Theme`
  - `applyTheme(theme: Theme): void` (signature unchanged from today)
  - `savePreference(preference: Preference): void`
  - `watchSystemTheme(callback: () => void): () => void` (returns an unsubscribe function)
- Removes: `savedTheme`, `saveTheme` (no aliases kept — Task 2 updates every caller in the same PR).

- [ ] **Step 1: Write the failing tests**

Create `web/src/theme.test.js`:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, effectiveTheme, savePreference, savedPreference, systemTheme, watchSystemTheme } from './theme.js';

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

/** @param {boolean} matches */
function fakeMatchMedia(matches) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const mediaQueryList = {
    matches,
    addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => listeners.add(fn),
    removeEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => listeners.delete(fn)
  };
  return { matchMedia: () => mediaQueryList, mediaQueryList, fire: () => listeners.forEach((fn) => fn()) };
}

function fakeDocument() {
  const documentElement = { dataset: /** @type {Record<string, string>} */ ({}), classList: { toggle: vi.fn() } };
  const meta = { setAttribute: vi.fn() };
  return { documentElement, meta, querySelector: () => meta };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('savedPreference', () => {
  it('returns the stored value for an explicit light or dark override', () => {
    localStorage.setItem('verdikt-theme', 'dark');
    expect(savedPreference()).toBe('dark');
    localStorage.setItem('verdikt-theme', 'light');
    expect(savedPreference()).toBe('light');
  });
  it('returns system when nothing is stored', () => {
    expect(savedPreference()).toBe('system');
  });
  it('returns system for a corrupt stored value', () => {
    localStorage.setItem('verdikt-theme', 'sepia');
    expect(savedPreference()).toBe('system');
  });
  it('returns system when localStorage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(savedPreference()).toBe('system');
  });
});

describe('systemTheme and effectiveTheme', () => {
  it('reads the OS preference through matchMedia', () => {
    vi.stubGlobal('matchMedia', fakeMatchMedia(true).matchMedia);
    expect(systemTheme()).toBe('dark');
    vi.stubGlobal('matchMedia', fakeMatchMedia(false).matchMedia);
    expect(systemTheme()).toBe('light');
  });
  it('passes an explicit preference through unchanged', () => {
    expect(effectiveTheme('light')).toBe('light');
    expect(effectiveTheme('dark')).toBe('dark');
  });
  it('resolves system through the OS preference', () => {
    vi.stubGlobal('matchMedia', fakeMatchMedia(true).matchMedia);
    expect(effectiveTheme('system')).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('paints the DOM attribute, class toggles, and theme-color meta for the given theme', () => {
    const fake = fakeDocument();
    vi.stubGlobal('document', fake);
    applyTheme('dark');
    expect(fake.documentElement.dataset.theme).toBe('dark');
    expect(fake.documentElement.classList.toggle).toHaveBeenCalledWith('wa-light', false);
    expect(fake.documentElement.classList.toggle).toHaveBeenCalledWith('wa-dark', true);
    expect(fake.meta.setAttribute).toHaveBeenCalledWith('content', '#141310');
  });
});

describe('savePreference', () => {
  it('removes the storage key for system and applies the resolved OS theme', () => {
    vi.stubGlobal('document', fakeDocument());
    vi.stubGlobal('matchMedia', fakeMatchMedia(true).matchMedia);
    localStorage.setItem('verdikt-theme', 'light');
    savePreference('system');
    expect(localStorage.getItem('verdikt-theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
  it('stores an explicit override and applies it directly', () => {
    vi.stubGlobal('document', fakeDocument());
    savePreference('dark');
    expect(localStorage.getItem('verdikt-theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('watchSystemTheme', () => {
  it('subscribes to matchMedia changes and the unsubscribe removes the listener', () => {
    const fake = fakeMatchMedia(false);
    vi.stubGlobal('matchMedia', fake.matchMedia);
    const callback = vi.fn();
    const unsubscribe = watchSystemTheme(callback);
    fake.fire();
    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
    fake.fire();
    expect(callback).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run web/src/theme.test.js`
Expected: FAIL — `savedPreference`, `effectiveTheme`, `systemTheme`, `savePreference`, `watchSystemTheme` are not exported by `theme.js` yet.

- [ ] **Step 3: Rewrite `web/src/theme.js`**

```js
const STORAGE_KEY = 'verdikt-theme';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** @typedef {'system'|'light'|'dark'} Preference */
/** @typedef {'light'|'dark'} Theme */

/** @returns {Preference} */
export function savedPreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** @returns {Theme} */
export function systemTheme() {
  return matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

/** @param {Preference} preference @returns {Theme} */
export function effectiveTheme(preference) {
  return preference === 'system' ? systemTheme() : preference;
}

/** @param {Theme} theme */
export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('wa-light', theme === 'light');
  root.classList.toggle('wa-dark', theme === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#141310' : '#f6f4ee');
}

/** @param {Preference} preference */
export function savePreference(preference) {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch { /* Storage may be unavailable in a privacy-restricted context. */ }
  applyTheme(effectiveTheme(preference));
}

/**
 * @param {() => void} callback
 * @returns {() => void} unsubscribe
 */
export function watchSystemTheme(callback) {
  const query = matchMedia(MEDIA_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run web/src/theme.test.js`
Expected: PASS (all cases from Step 1).

- [ ] **Step 5: Update the no-flash bootstrap in `web/index.html`**

Replace lines 65-71:

```html
    <script>
      try {
        const theme = localStorage.getItem('verdikt-theme') === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.add(`wa-${theme}`);
      } catch {}
    </script>
```

with:

```html
    <script>
      try {
        const stored = localStorage.getItem('verdikt-theme');
        const theme = stored === 'dark' || stored === 'light'
          ? stored
          : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.add(`wa-${theme}`);
      } catch {}
    </script>
```

This is deliberately not imported from `theme.js` — it must run synchronously before the stylesheet loads, same as before this change.

- [ ] **Step 6: Verify no other file still references the removed exports**

Run: `grep -rn "savedTheme\|saveTheme" web/src web/index.html`
Expected: matches only in `web/src/main.js` (still to be updated in Task 2) and `web/src/main.test.js` (still to be updated in Task 2) — none in `theme.js` or `index.html`.

- [ ] **Step 7: Commit**

```bash
git add web/src/theme.js web/src/theme.test.js web/index.html
git commit -m "Add a system theme preference alongside light/dark"
```

---

### Task 2: `main.js` — resolve, apply, and react to preference changes

**Files:**
- Modify: `web/src/main.js:8` (import), `:25-28` (initial theme), `:86-91` (`draw`), `:266-270` (theme-select listener)
- Modify: `web/src/main.test.js:36` (mock), plus new test cases at the end of the file

**Interfaces:**
- Consumes from Task 1: `savedPreference()`, `effectiveTheme(preference)`, `applyTheme(theme)`, `savePreference(preference)`, `watchSystemTheme(callback)`.
- Produces: a `syncTheme()` module-local function (not exported — internal to `main.js`) that reads the current preference, applies its effective theme, and sets `app.theme` to the preference.

- [ ] **Step 1: Update the mock and add the new test cases in `main.test.js`**

Add three fields to the hoisted `state` object (`web/src/main.test.js:7-11`):

```js
const state = vi.hoisted(() => ({
  account: /** @type {any} */ (null), session: /** @type {any} */ (null),
  changed: /** @type {any} */ (null), signIn: vi.fn(), ensureChain: vi.fn(),
  connectWallet: vi.fn(), disconnectWallet: vi.fn(), restoreWallet: vi.fn(),
  preference: /** @type {'system'|'light'|'dark'} */ ('system'),
  applyTheme: vi.fn(),
  systemChanged: /** @type {(() => void) | null} */ (null)
}));
```

Replace the `theme.js` mock (`web/src/main.test.js:36`):

```js
vi.mock('./theme.js', () => ({
  savedPreference: () => state.preference,
  effectiveTheme: (/** @type {string} */ preference) => (preference === 'system' ? 'light' : preference),
  applyTheme: state.applyTheme,
  savePreference: (/** @type {'system'|'light'|'dark'} */ preference) => { state.preference = preference; },
  watchSystemTheme: (/** @type {() => void} */ callback) => { state.systemChanged = callback; return () => { state.systemChanged = null; }; }
}));
```

Add two new tests at the end of `web/src/main.test.js`:

```js
it('repaints when the OS theme changes while following the system preference', () => {
  state.preference = 'system';
  state.applyTheme.mockClear();
  state.systemChanged?.();
  expect(state.applyTheme).toHaveBeenCalledOnce();
});
it('ignores an OS theme change while an explicit override is saved', () => {
  state.preference = 'dark';
  state.applyTheme.mockClear();
  state.systemChanged?.();
  expect(state.applyTheme).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the full file to verify the new tests fail (and existing ones break) for the right reason**

Run: `pnpm vitest run web/src/main.test.js`
Expected: FAIL across most tests — `main.js` still imports `savedTheme`/`saveTheme`, which the updated mock no longer exports, so `savedTheme is not a function` (or similar) throws during module load.

- [ ] **Step 3: Update `web/src/main.js`**

Change the import at line 8:

```js
import { applyTheme, effectiveTheme, savePreference, savedPreference, watchSystemTheme } from './theme.js';
```

Add a `syncTheme` function. Insert it directly after `main()`'s closing brace (after line 84, before the `draw` doc comment on line 86):

```js
function syncTheme() {
  const preference = savedPreference();
  applyTheme(effectiveTheme(preference));
  app.theme = preference;
}
```

Replace line 28 (`app.theme = savedTheme();`) with:

```js
syncTheme();
```

Replace line 90 (`app.theme = savedTheme();`, inside `draw()`) with:

```js
syncTheme();
```

Replace the `theme-select` listener (lines 267-270):

```js
app.addEventListener('theme-select', (event) => {
  savePreference(/** @type {CustomEvent<'system'|'light'|'dark'>} */ (event).detail);
  syncTheme();
});
```

Add, directly after that listener, a startup subscription that only repaints while the preference is still `'system'` — an OS change must not override an explicit choice:

```js
watchSystemTheme(() => {
  if (savedPreference() === 'system') syncTheme();
});
```

- [ ] **Step 4: Run the full file to verify all tests pass**

Run: `pnpm vitest run web/src/main.test.js`
Expected: PASS — every existing test plus the two new ones.

- [ ] **Step 5: Commit**

```bash
git add web/src/main.js web/src/main.test.js
git commit -m "React to system theme changes and persist only explicit overrides"
```

---

### Task 3: `lit-app.js` — three-way cycle on the nav toggle button

**Files:**
- Modify: `web/src/lit-app.js:19-20` (icons), `:147-154` (`nav`), `:216-235` (`VerdiktApp` properties/constructor/`changeTheme`)
- Modify: `web/src/lit-app.test.js` (new `describe` block)

**Interfaces:**
- Consumes from Task 1/2 (by convention only — no import): the `theme` value flowing into `nav()` and `VerdiktApp.theme` is now a `Preference` (`'system'|'light'|'dark'`), matching what `main.js`'s `syncTheme()` assigns to `app.theme`.
- Produces: `nav` becomes an exported function (was module-private), so `lit-app.test.js` can render it via `@lit-labs/ssr`, the same pattern `detailTemplate` already uses.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/lit-app.test.js` (it already imports `render as renderToIterable` from `@lit-labs/ssr` and defines a `stringify` helper — reuse both):

```js
import { nav } from './lit-app.js';

const noop = () => {};

describe('the nav theme toggle', () => {
  it('shows a monitor icon and offers Light next when following the system preference', () => {
    const markup = stringify(nav('landing', 'demo', 'system', null, noop, noop, noop, noop));
    expect(markup).toContain('aria-label="Switch to light mode"');
    expect(markup).toContain('x="3" y="4" width="18" height="13"');
  });
  it('shows a sun icon and offers Dark next in light mode', () => {
    const markup = stringify(nav('landing', 'demo', 'light', null, noop, noop, noop, noop));
    expect(markup).toContain('aria-label="Switch to dark mode"');
    expect(markup).toContain('cx="12" cy="12" r="4"');
  });
  it('shows a moon icon and offers System next in dark mode', () => {
    const markup = stringify(nav('landing', 'demo', 'dark', null, noop, noop, noop, noop));
    expect(markup).toContain('aria-label="Switch to system theme"');
    expect(markup).toContain('M21 12.79A9 9');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run web/src/lit-app.test.js`
Expected: FAIL — `nav` is not exported by `lit-app.js`, so the import fails.

- [ ] **Step 3: Add the system icon and the cycle maps**

In `web/src/lit-app.js`, after the existing `moonIcon` definition (line 20), add:

```js
const systemIcon = () => html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 20h8M12 17v3"/></svg>`;
const NEXT_PREFERENCE = { system: 'light', light: 'dark', dark: 'system' };
const PREFERENCE_ICON = { system: systemIcon, light: sunIcon, dark: moonIcon };
const PREFERENCE_LABEL = { system: 'Switch to light mode', light: 'Switch to dark mode', dark: 'Switch to system theme' };
```

- [ ] **Step 4: Export `nav` and switch it to the three-way cycle**

Replace the JSDoc + signature at line 147-148:

```js
/** @param {'landing'|'marketplace'|'service'|'manage'|'provider'|'register'|'how'|'terms'|'privacy'} view @param {'live'|'demo'} mode @param {'system'|'light'|'dark'} theme @param {string|null} account @param {(path: string) => void} go @param {() => void} connect @param {() => void} disconnect @param {(theme: 'system'|'light'|'dark') => void} changeTheme */
export const nav = (view, mode, theme, account, go, connect, disconnect, changeTheme) => {
```

Replace the `themeToggle` line (line 154):

```js
  const themeToggle = html`<button type="button" class="theme-toggle" aria-label=${PREFERENCE_LABEL[theme]} @click=${() => changeTheme(NEXT_PREFERENCE[theme])}>${PREFERENCE_ICON[theme]()}</button>`;
```

- [ ] **Step 5: Update `VerdiktApp`'s default and `changeTheme`'s JSDoc**

Line 216 (`static properties`) is unchanged — `theme: {}` already accepts any value.

Line 224, change the default and its JSDoc:

```js
    /** @type {'system'|'light'|'dark'} */ this.theme = 'system';
```

Line 234-235, change `changeTheme`'s JSDoc:

```js
  /** @param {'system'|'light'|'dark'} theme */
  changeTheme(theme) { this.dispatchEvent(new CustomEvent('theme-select', { detail: theme })); }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run web/src/lit-app.test.js`
Expected: PASS — all existing `detailTemplate` tests plus the three new `nav` tests.

- [ ] **Step 7: Commit**

```bash
git add web/src/lit-app.js web/src/lit-app.test.js
git commit -m "Cycle the nav theme button through system, light, and dark"
```

---

### Task 4: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the whole web test suite**

Run: `pnpm vitest run web`
Expected: PASS, no failures.

- [ ] **Step 2: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: both clean. Pay particular attention to `web/src/main.js` and `web/src/lit-app.js` — the literal union types (`'system'|'light'|'dark'`) must line up everywhere `theme`/`preference` is threaded through, or `tsc --noEmit` will flag a mismatch.

- [ ] **Step 3: Manual smoke check in the running dashboard**

Use the `run-web` skill (or `cd web && pnpm dev`) to start the dev server, then in a browser:
- Clear `localStorage` for the dev origin, load the page, confirm it renders in whatever the OS is currently set to (toggle the OS light/dark setting and reload to confirm both).
- Click the nav theme button three times and confirm the cycle is System → Light → Dark → System, the page repaints each click, and `localStorage.getItem('verdikt-theme')` is `null` on System, `'light'`/`'dark'` on the other two.
- While the button reads System, toggle the OS-level color scheme (or Chrome DevTools' rendering emulation for `prefers-color-scheme`) without reloading, and confirm the page repaints live and the tab's `theme-color` (visible in DevTools' Application/Manifest panel, or the mobile browser chrome color) updates.
- Reload with an explicit Dark override saved and confirm the page paints dark from the very first frame (no flash of light).

- [ ] **Step 4: Update `CLAUDE.md` if any documented behavior changed**

Grep for any mention of the theme toggle in `CLAUDE.md` (`grep -n -i theme CLAUDE.md`) — as of this plan's writing there is none, so no doc update is expected. If the grep turns up something, reconcile it with the new three-state behavior.
