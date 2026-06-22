// Intentionally narrow ESLint setup: this exists to catch correctness bugs the
// Vite build does not (e.g. `t is not defined` — a ReferenceError that only
// surfaces at runtime), NOT to enforce style. We enable a small set of
// real-bug rules and leave style rules off, so CI stays green on the existing
// codebase and only fails on genuine bugs.

import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'dev-dist/**', 'vendor/**', 'public/**', 'coverage/**'] },
  {
    files: ['**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        // Vite `define` injects this at build time.
        __APP_VERSION__: 'readonly',
      },
    },
    // Don't flag the codebase's existing, now-redundant eslint-disable comments.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      // Calling hooks conditionally/in loops is a guaranteed runtime bug.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
      // Real bug (a later key silently overrides an earlier one), but there are
      // pre-existing duplicates in the Spanish translations — surface as a
      // warning so it doesn't block CI until they're cleaned up.
      'no-dupe-keys': 'warn',
    },
  },
  // The service worker runs in a worker scope (self, caches, clients, ...).
  {
    files: ['src/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  // Tests + build/config files run under Node / vitest.
  {
    files: ['**/*.test.{js,jsx}', '**/test-setup.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
];
