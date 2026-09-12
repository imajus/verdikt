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
