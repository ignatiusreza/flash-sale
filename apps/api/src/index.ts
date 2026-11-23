import {
  connectBroker,
  declareTopology,
  onBrokerLost,
  publishAttempt,
  publishPresence,
  subscribeToEvents,
  type PurchaseResultsMessage,
} from '@flash-sale/messaging';
import { createLogger, startStats } from '@flash-sale/observability';
import pg from 'pg';

import { loadConfig, testEndpointsEnabled } from './config.js';
import { createGateway } from './realtime/gateway.js';
import { SaleCache } from './sale/cache.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { logger, flush } = createLogger({
    name: 'api',
    level: config.LOG_LEVEL,
    pretty: config.APP_ENV === 'development',
  });

  // Session timezone pinned on the connection, not inherited (docs/PLAN.md §9.1).
  // The connect timeout matters as much: without it an unreachable database
  // hangs rather than erroring, and the process just looks wedged.
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    options: '-c timezone=UTC',
    connectionTimeoutMillis: 5_000,
  });
  // See createPool in apps/worker: an idle client's error is not fatal here
  // either. The sale cache keeps its last snapshot and readiness reports it.
  pool.on('error', (error) => logger.error(`database: ${error.message}`));

  const saleCache = new SaleCache(pool, config.SALE_ID, config.SALE_REFRESH_MS);
  await saleCache.start();

  const connection = await connectBroker(config.RABBITMQ_URL);
  const { queue, exchange } = await declareTopology(connection, {
    environment: config.APP_ENV,
    ...(config.QUEUE_MAX_LENGTH ? { maxLength: config.QUEUE_MAX_LENGTH } : {}),
  });
  const channel = await connection.createConfirmChannel();
  // Without the broker the API can neither accept attempts nor deliver
  // results, so it exits and is restarted; clients reconnect to another
  // instance meanwhile and re-sync their orders.
  const releaseBroker = onBrokerLost(connection, [channel], (reason) => {
    logger.error(`${reason}; exiting for a restart`);
    flush();
    process.exit(1);
  });

  const stats = config.STATS_INTERVAL_MS ? startStats('api', config.STATS_INTERVAL_MS) : undefined;

  const app = await buildServer({
    pool,
    saleCache,
    saleId: config.SALE_ID,
    rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
    lookupLimitPerMinute: config.ORDER_LOOKUP_LIMIT_PER_MINUTE,
    publish: stats
      ? async (attempt) => {
          // The broker's confirm: how much of a POST's time is waiting on it.
          const started = performance.now();
          try {
            await publishAttempt(channel, queue, attempt);
          } finally {
            stats.record('publishConfirm', performance.now() - started);
          }
        }
      : (attempt) => publishAttempt(channel, queue, attempt),
    logger,
    ...(config.WEB_ROOT ? { webRoot: config.WEB_ROOT } : {}),
    trustProxy: config.TRUST_PROXY,
    enableTestEndpoints: testEndpointsEnabled(config),
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
    releaseBroker();
    saleCache.stop();
    await subscription.stop();
    await gateway.close();
    await app.close();
    await channel.close();
    await connection.close();
    await pool.end();
    flush();
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
