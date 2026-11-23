import {
  connectBroker,
  declareTopology,
  onBrokerLost,
  publishResults,
  ROUTING_KEY_RESULTS,
  startBatchConsumer,
} from '@flash-sale/messaging';
import { startStats } from '@flash-sale/stats';

import { createPool } from './db/pool.js';

import { isBadAttemptData } from './claim/failures.js';
import { handleBatch } from './claim/handler.js';
import { migrate } from './db/migrate.js';

/**
 * The single active consumer. RabbitMQ's `x-single-active-consumer` means
 * several of these can run: one is active, and the broker promotes another if
 * it dies, without the serialization ever being broken.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const rabbitUrl = process.env.RABBITMQ_URL;
  const saleId = process.env.SALE_ID ?? 'flash';
  // Must match the API's: see APP_ENV in apps/api/src/config.ts.
  const environment = process.env.APP_ENV ?? 'production';
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!rabbitUrl) throw new Error('RABBITMQ_URL is required');

  const pool = createPool(databaseUrl);
  await migrate(pool, (message) => console.warn(message));

  const connection = await connectBroker(rabbitUrl);
  // Must match the API's, or declaring the queue fails: see QUEUE_MAX_LENGTH
  // in apps/api/src/config.ts.
  const maxLength = Number(process.env.QUEUE_MAX_LENGTH) || undefined;
  const { queue, exchange } = await declareTopology(connection, {
    environment,
    ...(maxLength ? { maxLength } : {}),
  });
  const channel = await connection.createConfirmChannel();
  const releaseBroker = onBrokerLost(connection, [channel], (reason) => {
    console.error(`${reason}; exiting for a restart`);
    process.exit(1);
  });

  const batchMax = Number(process.env.CLAIM_BATCH_MAX) || undefined;
  // Where a batch's time goes, for the stress harness: see @flash-sale/stats.
  const statsIntervalMs = Number(process.env.STATS_INTERVAL_MS) || undefined;
  const stats = statsIntervalMs ? startStats('worker', statsIntervalMs) : undefined;
  const consumer = await startBatchConsumer({
    channel,
    queue,
    ...(batchMax ? { batchMax } : {}),
    isPermanent: isBadAttemptData,
    handle: async (attempts) => {
      const started = performance.now();
      if (stats) {
        // How long each attempt sat in the queue before its batch began.
        const now = Date.now();
        for (const attempt of attempts)
          stats.record('queueWait', now - Date.parse(attempt.requestedAt));
        stats.record('batchSize', attempts.length);
      }
      const message = await handleBatch(pool, saleId, attempts);
      stats?.record('claim', performance.now() - started);
      // After the commit, never before: see startBatchConsumer.
      publishResults(channel, exchange, ROUTING_KEY_RESULTS, message);
    },
    onError: (error) => console.error(error),
  });

  console.warn(`worker consuming ${queue} as ${consumer.consumerTag}`);

  const shutdown = async () => {
    releaseBroker();
    await consumer.stop();
    await channel.close();
    await connection.close();
    await pool.end();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (process.argv[1]?.endsWith('index.js')) {
  main().catch((error: unknown) => {
    console.error(error);
    // Not exitCode: whatever started before the failure, a database pool or a
    // timer, would keep a process alive that serves nothing, and a restart
    // policy never sees it fail.
    process.exit(1);
  });
}
