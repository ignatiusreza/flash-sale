import { randomUUID } from 'node:crypto';

import { PublishRejected, publishAttempt } from '@flash-sale/messaging';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

import { admit } from './admission.js';
import { findOrder } from './orders.js';
import { TokenBucket } from './rate-limit.js';
import type { SaleCache } from './sale-cache.js';

export interface ServerDeps {
  readonly pool: pg.Pool;
  readonly saleCache: SaleCache;
  readonly saleId: string;
  readonly rateLimitPerMinute: number;
  /** Publishes an attempt and resolves only once the broker confirms it. */
  readonly publish: (attempt: Parameters<typeof publishAttempt>[2]) => Promise<void>;
  readonly logger?: boolean;
}

const purchaseBody = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Fastify's ajv strips unknown properties by default, which makes
    // `additionalProperties: false` silently permissive. On a purchase endpoint
    // an unexpected field is more likely a client bug than noise worth ignoring.
    ajv: { customOptions: { removeAdditional: false } },
  });
  const ipLimiter = TokenBucket.perMinute(deps.rateLimitPerMinute);
  const userLimiter = TokenBucket.perMinute(deps.rateLimitPerMinute);

  const idle = setInterval(() => {
    ipLimiter.evictIdle();
    userLimiter.evictIdle();
  }, 60_000);
  idle.unref();
  app.addHook('onClose', () => {
    clearInterval(idle);
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    // Ready means "can answer correctly", which needs the sale snapshot. A
    // process that is up but has never read the sale would admit everything.
    if (!deps.saleCache.healthy) return reply.code(503).send({ status: 'not_ready' });
    return { status: 'ready' };
  });

  app.get('/api/sale', async (_request, reply) => {
    const view = deps.saleCache.view();
    if (!view) return reply.code(503).send({ error: 'sale_unavailable' });

    // Served entirely from memory: no I/O on the highest-volume endpoint.
    return {
      ...view,
      // So the client can run a countdown without trusting its own clock (§9.1).
      serverTime: new Date().toISOString(),
    };
  });

  app.get<{ Params: { userId: string } }>('/api/purchase/:userId', async (request, reply) => {
    const { userId } = request.params;
    const order = await findOrder(deps.pool, deps.saleId, userId);
    if (!order) return reply.send({ status: 'none' });
    return reply.send({ status: 'confirmed', ...order });
  });

  app.post<{ Body: { userId: string } }>(
    '/api/purchase',
    { schema: { body: purchaseBody } },
    async (request, reply) => {
      const { userId } = request.body;

      if (!ipLimiter.take(request.ip) || !userLimiter.take(userId)) {
        return reply.code(429).send({ error: 'rate_limited' });
      }

      // Free, in-process rejection of everything already doomed (§6).
      const decision = admit(deps.saleCache);
      if (!decision.admit) {
        return reply.code(409).send({ status: decision.reason });
      }

      const attemptId = randomUUID();
      try {
        await deps.publish({
          attemptId,
          saleId: deps.saleId,
          userId,
          requestedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error instanceof PublishRejected) {
          // The queue is at its bound: shed cleanly rather than retry (§5).
          return reply.code(503).send({ error: 'busy' });
        }
        throw error;
      }

      // 202, not 200: the outcome arrives over the socket. Returning only once
      // the broker has confirmed is what makes that promise keepable — an
      // unconfirmed publish could vanish and the user would wait forever.
      return reply.code(202).send({ status: 'queued', attemptId });
    },
  );

  return app;
}
