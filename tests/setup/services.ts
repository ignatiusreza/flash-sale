import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ensureDatabase } from '../../apps/worker/src/db/ensure-database.js';

/**
 * Points the integration tests at Postgres and RabbitMQ, with the same local
 * defaults as `pnpm dev`, so `pnpm test` on a machine running both needs no
 * setup.
 *
 * It is `APP_ENV=test`: the database is `flashsale_test` rather than the dev
 * one, so a test run never writes into data you are clicking through, and it
 * is created if missing. The queue tests already use a queue per test.
 *
 * A URL set explicitly — shell, `.env`, CI, the compose runner — is used as
 * given and must be reachable. A default that is not reachable is dropped
 * instead, and the suites that need it skip: a checkout with no local services
 * should still be able to run the unit tests.
 */
const APP_ENV = 'test';

const DEFAULTS = {
  DATABASE_URL: `postgres://postgres@localhost:5432/flashsale_${APP_ENV}`,
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
} as const;

export default async function setup(): Promise<void> {
  process.env.APP_ENV = APP_ENV;
  const envFile = path.resolve(import.meta.dirname, '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    if (process.env[name]) continue;
    const url = new URL(fallback);
    if (await reachable(url.hostname, Number(url.port))) {
      process.env[name] = fallback;
    } else {
      console.warn(`${name} unset and nothing on ${url.host}: skipping the suites that need it`);
    }
  }

  if (process.env.DATABASE_URL) await ensureDatabase(process.env.DATABASE_URL);
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const settle = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}
