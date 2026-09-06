import { defineConfig } from 'vitest/config';

// Single root config on purpose: per-package vitest configs would be one more
// file each parallel job wants to edit. Tests are picked up by glob instead.
export default defineConfig({
  test: {
    include: ['{packages,fixtures,cre,proxy,web}/**/*.test.js'],
    exclude: ['**/node_modules/**', '**/dist/**', 'contracts/**'],
    environment: 'node'
    // `passWithNoTests` lived here through Wave 0 and is gone now that Spike C
    // has landed real tests: an empty suite is once again a failure, which is
    // the only way "someone deleted every test" ever gets noticed.
  }
});
