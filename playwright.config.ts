import { defineConfig, devices } from '@playwright/test';

/** Not 3000, so the suite can run alongside a `pnpm dev` API's port. */
const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  // One sale, reseeded by each spec: running specs side by side would have
  // them resetting each other's sale mid-purchase (docs/PLAN.md §11).
  fullyParallel: false,
  workers: 1,
  // No retries: a flaky E2E suite trains people to re-run red builds, which is
  // worse than not having one. A flake is a bug to fix, not to absorb.
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `http://localhost:${PORT}/healthz`,
    env: { PORT: String(PORT) },
    // Always a fresh stack: reusing one left over from an earlier run would
    // test whatever that run built.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
