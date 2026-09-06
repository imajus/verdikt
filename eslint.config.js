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
      // Bun/CRE islands with their own toolchain (docs/spikes/cre.md, CRE-5),
      // plus the bundler's own build artefacts, which are vendored code.
      'cre/spike/**',
      'cre/workflows/**/.tmp/**',
      'cre/workflows/**/.cre_build_tmp.js'
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      // `latest`, not a pinned year: @verdikt/sla imports schema.json with an
      // import attribute (`with { type: 'json' }`), which 2023 cannot parse.
      ecmaVersion: 'latest',
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
