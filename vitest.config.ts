import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const source = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // The workspace packages export their built `dist/`, which a fresh clone
  // does not have: tests read their sources instead, so `pnpm test` needs no
  // build first and never tests a stale one.
  resolve: {
    alias: {
      '@flash-sale/core': source('core'),
      '@flash-sale/messaging': source('messaging'),
      '@flash-sale/observability': source('observability'),
    },
  },
  test: {
    // One Postgres and one RabbitMQ are shared by every suite, so running files
    // in parallel means competing for connections and broker resources. The
    // failures that produces look like bugs in the code under test — the whole
    // suite passes in isolation and fails together — which is worse than the
    // second or two this costs.
    fileParallelism: false,
    // Resolves DATABASE_URL / RABBITMQ_URL before any test file reads them.
    globalSetup: ['tests/setup/services.ts'],
    include: [
      '{apps,packages}/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    // dist/ would otherwise contribute a compiled duplicate of every test, and
    // tests/e2e belongs to Playwright, which has its own runner.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'tests/stress/**'],
  },
});
