import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One Postgres and one RabbitMQ are shared by every suite, so running files
    // in parallel means competing for connections and broker resources. The
    // failures that produces look like bugs in the code under test — the whole
    // suite passes in isolation and fails together — which is worse than the
    // second or two this costs.
    fileParallelism: false,
    include: ['{apps,packages}/*/src/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // dist/ would otherwise contribute a compiled duplicate of every test, and
    // tests/e2e belongs to Playwright, which has its own runner.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', 'tests/stress/**'],
  },
});
