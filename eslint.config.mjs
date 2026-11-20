import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'pnpm-lock.yaml',
      // Throwaway benchmark harnesses that exist to document a measurement,
      // not to ship. docs/prototype/README.md says what becomes of each.
      'docs/prototype/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Unused args are often part of a signature we must match; allow the
      // conventional underscore opt-out rather than deleting the parameter.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: { ...globals.browser },
    },
    settings: {
      // Pinned deliberately: auto-detect is unreliable on recent ESLint majors
      // and silently disables version-dependent rules when it fails.
      react: { version: '19.3' },
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The new JSX transform means React need not be in scope.
      'react/react-in-jsx-scope': 'off',
    },
  },

  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },

  prettier,
);
