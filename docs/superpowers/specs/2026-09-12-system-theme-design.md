# System theme option

[GitHub issue #32](https://github.com/imajus/verdikt/issues/32). The dashboard's
Light/Dark toggle is a two-state cycle persisted to `localStorage`. This adds a
third, non-persisted `System` state that tracks `prefers-color-scheme`, while
keeping explicit Light/Dark as durable overrides.

`theme.js` today conflates two things under one `Theme = 'light'|'dark'` type:
what's *persisted* and what's *painted*. This design splits them:

- **`Preference`** (`'system'|'light'|'dark'`) — what's persisted and what the
  UI control shows as selected.
- **`Theme`** (`'light'|'dark'`, unchanged) — what's actually painted: the
  `data-theme` attribute, the `wa-light`/`wa-dark` class, and the `theme-color`
  meta tag.

## 1 · `theme.js`

```js
/** @typedef {'system'|'light'|'dark'} Preference */
/** @typedef {'light'|'dark'} Theme */

const STORAGE_KEY = 'verdikt-theme';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

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
export function applyTheme(theme) { /* unchanged body */ }

/** @param {Preference} preference */
export function savePreference(preference) {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch { /* Storage may be unavailable in a privacy-restricted context. */ }
  applyTheme(effectiveTheme(preference));
}

/** @param {() => void} callback @returns {() => void} unsubscribe */
export function watchSystemTheme(callback) {
  const query = matchMedia(MEDIA_QUERY);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}
```

`savedTheme`/`saveTheme` are removed outright — every caller moves to the
functions above, there is no transitional alias.

An explicit stored value always wins; `savedPreference` only falls through to
`'system'` when the key is absent, unset, or holds neither `'light'` nor
`'dark'` (covers a corrupted or manually-edited value the same way the old
code's `=== 'dark' ? 'dark' : 'light'` fallback did).

## 2 · No-flash bootstrap (`index.html`)

The inline pre-paint script resolves `'system'`/missing storage through
`matchMedia` synchronously, instead of defaulting to `'light'`:

```js
try {
  const stored = localStorage.getItem('verdikt-theme');
  const theme = stored === 'dark' || stored === 'light'
    ? stored
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.add(`wa-${theme}`);
} catch {}
```

This duplicates `theme.js`'s resolution logic on purpose, as it already did
before this change — it must run synchronously before the stylesheet loads,
which rules out importing the module.

## 3 · Wiring (`main.js`)

`app.theme` (the Lit property) now holds the **preference**, not the effective
theme — it drives which icon the nav button shows. A `syncTheme()` helper
resolves and applies the effective theme:

```js
function syncTheme() {
  const preference = savedPreference();
  applyTheme(effectiveTheme(preference));
  app.theme = preference;
}
```

Called:

- Once at startup, replacing `app.theme = savedTheme()`.
- From the `theme-select` listener, replacing the current
  `saveTheme(event.detail); app.theme = savedTheme();` pair:
  ```js
  app.addEventListener('theme-select', (event) => {
    savePreference(/** @type {CustomEvent<Preference>} */ (event).detail);
    syncTheme();
  });
  ```
- From a `watchSystemTheme` subscription set up once at startup, **guarded**
  so an OS-level change is a no-op while an explicit override is active:
  ```js
  watchSystemTheme(() => {
    if (savedPreference() === 'system') syncTheme();
  });
  ```

Calling `applyTheme` from `syncTheme()` at startup — where today's code only
sets the Lit property — also fixes a latent gap: a page load with an explicit
`dark` override never repainted the `theme-color` meta tag, which stayed at
the HTML's static light default until the user's next click. Same root cause,
one fix; not a separate change.

## 4 · UI (`lit-app.js`)

Per-answer: keep the single icon-only nav button rather than a segmented
control or dropdown, matching the existing tight icon row in `.nav-external`.
Clicking now cycles `system → light → dark → system`. A third icon (a
circle-half "system" glyph, same 16×16 stroke style as the existing
`sunIcon`/`moonIcon`) is added next to them.

```js
const NEXT_PREFERENCE = { system: 'light', light: 'dark', dark: 'system' };
const PREFERENCE_ICON = { system: systemIcon, light: sunIcon, dark: moonIcon };
const PREFERENCE_LABEL = { system: 'Switch to light mode', light: 'Switch to dark mode', dark: 'Switch to system theme' };
```

`nav()`'s `theme` parameter is now a `Preference`; the button's `aria-label`
and icon come from the maps above keyed on the current preference, and
`@click` calls `changeTheme(NEXT_PREFERENCE[theme])`. `changeTheme` and the
`theme-select` event dispatch are otherwise unchanged. The default value of
the `theme` property (`lit-app.js`'s constructor) moves from `'light'` to
`'system'`, matching the new default preference.

## 5 · Testing

- **New `web/src/theme.test.js`** (none exists today):
  - `savedPreference` — returns `'light'`/`'dark'` for those stored values,
    `'system'` for missing/unset/corrupt storage, and `'system'` when
    `localStorage` throws.
  - `effectiveTheme` — passes through `'light'`/`'dark'`; resolves `'system'`
    via a mocked `matchMedia`.
  - `savePreference` — `'system'` removes the storage key; `'light'`/`'dark'`
    set it; both call `applyTheme` with the correct effective theme.
  - `watchSystemTheme` — registers a `change` listener on the media query
    and the returned unsubscribe removes it.
  - `applyTheme` — existing behavior (DOM attribute/class, `theme-color`
    meta), carried over from having no prior coverage.
- **`main.test.js`** — update `vi.mock('./theme.js', ...)` for the renamed
  exports (`savedPreference`, `effectiveTheme`, `applyTheme`, `savePreference`,
  `watchSystemTheme`), and add coverage for `syncTheme()`'s guard: a
  `watchSystemTheme` callback firing while an explicit override is saved must
  not repaint.
- **`lit-app.test.js`** — currently has no theme/toggle assertions at all;
  this is the first coverage of that button. Add cases for the three icons,
  the three `aria-label`s, and the cycle order.

## Explicitly out of scope

- No change to the two theme colors themselves (`#f6f4ee` / `#141310`).
- No cross-tab sync (a `storage` event listener) — an explicit override
  written in one tab does not live-update another open tab. Not required by
  the issue's acceptance criteria.
- No change to `applyTheme`'s signature or DOM side effects.
