import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '../lib/stack.mjs';
import { rssOf, until, untilOk } from './wait.mjs';

const PORTS = [3200, 3201];

/**
 * Builds the app and starts a stack of its own for `scenario`: a fresh
 * database and queue (`APP_ENV=stress`, so it runs beside `pnpm dev` and the
 * E2E suite), a seeded sale, two API instances and the worker.
 *
 * Two instances, so buyers can connect their socket to one and POST to the
 * other, and every result has to cross between them. The harness also hears
 * every result the worker announces, the way an API instance does, so the
 * checks can hold each one against Postgres rather than count k6's.
 */
export async function startStack(stress, scenario) {
  const env = await stress.resolveServices('stress', { readEnvFile: false });
  await stress.checkPorts(
    PORTS.map((port, i) => [`API ${i}`, port]),
    'is an earlier stress run still going? Stop it, or free the port, then retry',
  );

  stress.say('building…');
  await stress.run('pnpm', ['-s', 'build']);
  await stress.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'create-database'], env);
  await stress.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'migrate'], env);

  const fromWorker = createRequire(path.join(ROOT, 'apps/worker/package.json'));
  const pg = fromWorker('pg');
  const amqp = fromWorker('amqplib');
  const { subscribeToEvents, topologyNames } = await import(
    pathToFileURL(fromWorker.resolve('@flash-sale/messaging')).href
  );
  const { queue, exchange } = topologyNames('stress');

  // A clean queue: leftovers from an aborted run would be claimed into this
  // sale, and a different bound cannot be declared over an existing queue.
  const broker = await amqp.connect(env.RABBITMQ_URL);
  const channel = await broker.createChannel();
  await channel.deleteQueue(queue);

  stress.say(`seeding a sale of ${scenario.stock} units…`);
  await stress.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'seed'], {
    ...env,
    SEED_STOCK: String(scenario.stock),
    SEED_DURATION_MINUTES: '60',
    SEED_RESET: '1',
  });

  const shared = {
    ...env,
    ...(scenario.queueMax ? { QUEUE_MAX_LENGTH: String(scenario.queueMax) } : {}),
  };
  const sameGroup = { ownGroup: false };
  const startWorker = () =>
    stress.start('worker', 'node', ['apps/worker/dist/index.js'], shared, sameGroup);

  if (scenario.worker === 'from the start') startWorker();
  const apis = PORTS.map((port, i) =>
    stress.start(
      `api${i}`,
      'node',
      ['apps/api/dist/index.js'],
      // k6 stands in for many clients, one address each, through a "proxy".
      { ...shared, PORT: String(port), TRUST_PROXY: 'true' },
      sameGroup,
    ),
  );
  await Promise.all(PORTS.map((port) => untilOk(`http://localhost:${port}/readyz`)));

  // Published unconfirmed — a lost one is recovered by the client's order
  // lookup — but nothing here loses them, so each must arrive.
  const results = [];
  await subscribeToEvents(await broker.createChannel(), exchange, {
    onResults: (message) => results.push(...message.results),
  });

  async function query(sql) {
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
      return (await client.query(sql)).rows;
    } finally {
      await client.end();
    }
  }

  return {
    baseUrls: PORTS.map((port) => `http://localhost:${port}`),
    /** Every result the worker has announced so far. */
    results,
    startWorker,
    /** Each API instance's resident memory, in kB. */
    apiMemory: () => apis.map(rssOf),

    /** Orders taken, and stock left. */
    ledger: async () =>
      (
        await query(
          `SELECT (SELECT count(*)::int FROM orders WHERE sale_id = 'flash') AS orders,
                  (SELECT remaining FROM sales WHERE id = 'flash') AS remaining`,
        )
      )[0],

    /** Orders taken, and the seconds between the first and the last. */
    claimSpan: async () =>
      (
        await query(
          `SELECT count(*)::int AS orders,
                  coalesce(extract(epoch FROM max(created_at) - min(created_at)), 0)::float AS seconds
           FROM orders WHERE sale_id = 'flash'`,
        )
      )[0],

    /** Each buyer's order, by user id. */
    heldOrders: async () =>
      new Map(
        (await query("SELECT user_id, id FROM orders WHERE sale_id = 'flash'")).map((row) => [
          row.user_id,
          row.id,
        ]),
      ),

    /** The worker has taken everything: nothing waiting, nothing unacknowledged. */
    untilQueueEmpty: async () => {
      await until(async () => (await channel.checkQueue(queue)).messageCount === 0, 120_000);
      // Unacknowledged deliveries do not count as waiting; give the last batch
      // time to commit before reading the ledger.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    },

    close: () => broker.close().catch(() => {}),
  };
}
