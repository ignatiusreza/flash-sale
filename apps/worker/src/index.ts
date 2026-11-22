import {
  assertTopology,
  publishResults,
  ROUTING_KEY_RESULTS,
  startBatchConsumer,
} from '@flash-sale/messaging';
import amqp from 'amqplib';

import { createPool } from './db/pool.js';
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

  const connection = await amqp.connect(rabbitUrl);
  const channel = await connection.createConfirmChannel();
  const { queue, exchange } = await assertTopology(channel, { environment });

  const consumer = await startBatchConsumer({
    channel,
    queue,
    handle: async (attempts) => {
      const message = await handleBatch(pool, saleId, attempts);
      // After the commit, never before: see startBatchConsumer.
      publishResults(channel, exchange, ROUTING_KEY_RESULTS, message);
    },
    onError: (error) => console.error(error),
  });

  console.warn(`worker consuming ${queue} as ${consumer.consumerTag}`);

  const shutdown = async () => {
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
    process.exitCode = 1;
  });
}
