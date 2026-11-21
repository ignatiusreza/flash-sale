import {
  assertTopology,
  publishAttempt,
  publishPresence,
  subscribeToEvents,
  type PurchaseResultsMessage,
} from '@flash-sale/messaging';
import amqp from 'amqplib';
import pg from 'pg';

import { loadConfig } from './config.js';
import { createGateway } from './realtime/gateway.js';
import { SaleCache } from './sale/cache.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Session timezone pinned on the connection, not inherited (docs/PLAN.md §9.1).
  // The connect timeout matters as much: without it an unreachable database
  // hangs rather than erroring, and the process just looks wedged.
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    options: '-c timezone=UTC',
    connectionTimeoutMillis: 5_000,
  });

  const saleCache = new SaleCache(pool, config.SALE_ID, config.SALE_REFRESH_MS);
  await saleCache.start();

  const connection = await amqp.connect(config.RABBITMQ_URL);
  const channel = await connection.createConfirmChannel();
  const { queue, exchange } = await assertTopology(channel);

  const app = await buildServer({
    pool,
    saleCache,
    saleId: config.SALE_ID,
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
    publish: (attempt) => publishAttempt(channel, queue, attempt),
    logger: true,
  });

  // Listen before attaching the gateway: Socket.IO needs the underlying server,
  // and Fastify only creates it once it is listening.
  await app.listen({ port: config.PORT, host: config.HOST });

  const gateway = createGateway({
    httpServer: app.server,
    saleCache,
    announcePresence: (connections, instanceId) =>
      publishPresence(channel, exchange, {
        instanceId,
        connections,
        at: new Date().toISOString(),
      }),
  });

  // Every instance receives every event; each delivers only to the sockets it
  // holds, so no shared adapter or user-to-instance registry is needed (§8).
  const subscription = await subscribeToEvents(channel, exchange, {
    onResults: (message) => gateway.handleResults(message as PurchaseResultsMessage),
    onPresence: (message) => {
      if (message.instanceId !== gateway.instanceId) {
        gateway.handlePresence(message.instanceId, message.connections);
      }
    },
  });

  app.log.info(`realtime gateway ready as ${gateway.instanceId}`);

  const shutdown = async () => {
    saleCache.stop();
    await subscription.stop();
    await gateway.close();
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
