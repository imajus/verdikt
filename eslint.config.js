import js from '@eslint/js';
import globals from 'globals';

// Root-level on purpose, like vitest.config.js: one lint config nobody has to
// edit per package. Node globals are declared here up front so that a job
// writing proxy or CRE code hits no-undef on `process` and has to come back
// and edit a shared file.
export default [
  {
    // cre/spike is a bun-installed TypeScript island with its own toolchain
    // (docs/spikes/cre.md, CRE-5); the root JS lint config does not apply to it.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'contracts/out/**',
      'contracts/cache/**',
      'cre/spike/**'
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      // Wave 0 ships stubs whose parameters document the seam but go unused
      // until the bodies land. Unused *variables* still error.
      'no-unused-vars': ['error', { args: 'none' }]
    }
  }
];
