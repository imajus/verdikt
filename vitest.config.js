import { defineConfig } from 'vitest/config';

// Single root config on purpose: per-package vitest configs would be one more
// file each parallel job wants to edit. Tests are picked up by glob instead.
export default defineConfig({
  test: {
    include: ['{packages,fixtures,cre,proxy,web}/**/*.test.js'],
    exclude: ['**/node_modules/**', '**/dist/**', 'contracts/**'],
    environment: 'node',
    // Wave 0 ships seams and no tests, and vitest exits 1 on an empty suite.
    // Drop this the moment Phase 1 lands its first test — left in place it
    // would also swallow "someone deleted every test".
    passWithNoTests: true
  }
});
