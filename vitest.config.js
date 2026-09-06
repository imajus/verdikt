import { defineConfig } from 'vitest/config';

// Single root config on purpose: per-package vitest configs would be one more
// file each parallel job wants to edit. Tests are picked up by glob instead.
export default defineConfig({
  test: {
    include: ['{packages,fixtures,cre,proxy,web,scripts}/**/*.test.js'],
    exclude: ['**/node_modules/**', '**/dist/**', 'contracts/**'],
    environment: 'node'
  }
});
