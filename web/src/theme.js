const STORAGE_KEY = 'verdikt-theme';

/** @typedef {'light'|'dark'} Theme */

/** @returns {Theme} */
export function savedTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** @param {Theme} theme */
export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('wa-light', theme === 'light');
  root.classList.toggle('wa-dark', theme === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#141310' : '#f6f4ee');
}

/** @param {Theme} theme */
export function saveTheme(theme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* Storage may be unavailable in a privacy-restricted context. */ }
  applyTheme(theme);
}
