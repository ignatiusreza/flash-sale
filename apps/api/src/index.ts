import { assertTopology, publishAttempt } from '@flash-sale/messaging';
import amqp from 'amqplib';
import pg from 'pg';

import { loadConfig } from './config.js';
import { SaleCache } from './sale-cache.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Session timezone pinned on the connection, not inherited (docs/PLAN.md §9.1).
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, options: '-c timezone=UTC' });

  const saleCache = new SaleCache(pool, config.SALE_ID, config.SALE_REFRESH_MS);
  await saleCache.start();

  const connection = await amqp.connect(config.RABBITMQ_URL);
  const channel = await connection.createConfirmChannel();
  const { queue } = await assertTopology(channel);

  const app = await buildServer({
    pool,
    saleCache,
    saleId: config.SALE_ID,
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
    publish: (attempt) => publishAttempt(channel, queue, attempt),
    logger: true,
  });

  await app.listen({ port: config.PORT, host: config.HOST });

  const shutdown = async () => {
    saleCache.stop();
    await app.close();
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
