#!/usr/bin/env node
/**
 * The stack the Playwright suite runs against, started by its `webServer`
 * config: the built API serving the built SPA on one origin, and a worker.
 * Production-shaped on purpose — E2E should exercise the serving path that
 * ships, not the Vite dev server.
 *
 * It is `APP_ENV=e2e`: its own database and its own RabbitMQ queue and
 * exchange, on its own port, so it runs beside `pnpm dev` on the same services
 * without either touching the other's data. Being the E2E environment is also
 * what makes the API register the test-only reset endpoint, which wipes the
 * sale's orders.
 */
import { supervisor } from './lib/stack.mjs';

const e2e = supervisor('e2e');
const PORT = Number(process.env.PORT || 3100);

// Not `.env`: that is development configuration. A DATABASE_URL there names
// the development database, and the reset endpoint would wipe its orders.
// Service locations come from the shell (as CI provides them) or the defaults.
const env = await e2e.resolveServices('e2e', { readEnvFile: false });
await e2e.checkPorts(
  [['E2E API', PORT]],
  'is an earlier E2E run still going? Stop it, or free the port, then retry',
);

e2e.say('building…');
await e2e.run('pnpm', ['-s', 'build']);

e2e.say('preparing the database…');
await e2e.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'create-database'], env);
await e2e.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'migrate'], env);

// In our process group, not their own: Playwright stops the web server by
// SIGKILLing its group, and anything outside it would outlive the run and hold
// the port against the next one.
const sameGroup = { ownGroup: false };

e2e.say(`starting worker and api on :${PORT}`);
e2e.start('worker', 'node', ['apps/worker/dist/index.js'], env, sameGroup);
e2e.start(
  'api',
  'node',
  ['apps/api/dist/index.js'],
  { ...env, PORT: String(PORT), WEB_ROOT: 'apps/web/dist' },
  sameGroup,
);
