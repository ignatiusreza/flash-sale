import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // dist/ would otherwise contribute a compiled duplicate of every test, and
    // tests/e2e belongs to Playwright, which has its own runner.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'tests/stress/**'],
  },
});
