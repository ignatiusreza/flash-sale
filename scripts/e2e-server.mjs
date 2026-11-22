#!/usr/bin/env node
/**
 * The stack the Playwright suite runs against, started by its `webServer`
 * config: the built API serving the built SPA on one origin, and a worker.
 * Production-shaped on purpose — E2E should exercise the serving path that
 * ships, not the Vite dev server.
 *
 * It uses its own database, and the API registers the test-only reset
 * endpoint (`ENABLE_TEST_ENDPOINTS`) so each spec can seed a fresh sale.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, supervisor } from './lib/stack.mjs';

const e2e = supervisor('e2e');
const PORT = Number(process.env.PORT || 3100);

/**
 * Refuses to start while anything else consumes the attempts queue. A
 * `pnpm dev` worker on the same broker would take the suite's attempts and
 * settle them against the development database, so every purchase in every
 * spec would hang on "queued" — failures that look exactly like real bugs.
 */
async function refuseForeignConsumers(rabbitmqUrl) {
  const fromWorker = createRequire(path.join(ROOT, 'apps/worker/package.json'));
  const amqp = fromWorker('amqplib');
  const { ATTEMPTS_QUEUE } = await import(
    pathToFileURL(fromWorker.resolve('@flash-sale/messaging')).href
  );

  const connection = await amqp.connect(rabbitmqUrl);
  try {
    const channel = await connection.createChannel();
    // A missing queue closes the channel with a 404; that is "no consumers".
    channel.on('error', () => {});
    const consumers = await channel
      .checkQueue(ATTEMPTS_QUEUE)
      .then((queue) => queue.consumerCount)
      .catch(() => 0);

    if (consumers > 0) {
      e2e.say(`${consumers} consumer(s) already on ${ATTEMPTS_QUEUE} — is \`pnpm dev\` running?`);
      e2e.say('  its worker would take the suite’s attempts; stop it, then retry');
      process.exit(1);
    }
  } finally {
    await connection.close().catch(() => {});
  }
}

const env = await e2e.resolveServices({
  DATABASE_URL: 'postgres://postgres@localhost:5432/flashsale_e2e',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
});
await e2e.checkPorts(
  [['E2E API', PORT]],
  'is an earlier E2E run still going? Stop it, or free the port, then retry',
);

e2e.say('building…');
await e2e.run('pnpm', ['-s', 'build']);

e2e.say('preparing the database…');
await e2e.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'create-database'], env);
await e2e.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'migrate'], env);

await refuseForeignConsumers(env.RABBITMQ_URL);

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
  { ...env, PORT: String(PORT), WEB_ROOT: 'apps/web/dist', ENABLE_TEST_ENDPOINTS: 'true' },
  sameGroup,
);
