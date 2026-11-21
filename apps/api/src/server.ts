import { randomUUID } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { PublishRejected, publishAttempt } from '@flash-sale/messaging';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type pg from 'pg';

import { admit } from './admission.js';
import { findOrder } from './orders.js';
import {
  healthSchema,
  openApiDocument,
  purchaseSchema,
  purchaseStatusSchema,
  readySchema,
  saleSchema,
} from './schemas.js';
import type { SaleCache } from './sale-cache.js';

export interface ServerDeps {
  readonly pool: pg.Pool;
  readonly saleCache: SaleCache;
  readonly saleId: string;
  readonly rateLimitPerMinute: number;
  /** Publishes an attempt and resolves only once the broker confirms it. */
  readonly publish: (attempt: Parameters<typeof publishAttempt>[2]) => Promise<void>;
  readonly logger?: boolean;
  /** Serve the OpenAPI document and its UI. On by default. */
  readonly docs?: boolean;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Fastify's ajv strips unknown properties by default, which makes
    // `additionalProperties: false` silently permissive. On a purchase endpoint
    // an unexpected field is more likely a client bug than noise worth ignoring.
    ajv: { customOptions: { removeAdditional: false } },
  });

  // `global: false`: only the purchase endpoint is limited. `/api/sale` is
  // polled by every open tab by design, and limiting health checks would make
  // a busy instance look unhealthy.
  await app.register(rateLimit, { global: false });

  // Registered before the routes: the spec is built from the schemas declared
  // on them, so anything added afterwards would be missing from the document.
  if (deps.docs ?? true) {
    await app.register(swagger, openApiDocument);
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  const limits = { max: deps.rateLimitPerMinute, timeWindow: 60_000 };
  const byIp = app.createRateLimit(limits);
  const byUser = app.createRateLimit({
    ...limits,
    keyGenerator: (request) => (request.body as { userId?: string } | undefined)?.userId ?? 'anon',
  });

  // `createRateLimit` returns the verdict but does not set response headers the
  // way the route-level plugin does, so they are set from its result here.
  // Telling the client when to come back matters: during a flash sale, a client
  // left to guess retries immediately.
  function tooManyRequests(
    reply: FastifyReply,
    limit: { max: number; remaining: number; ttlInSeconds: number },
  ) {
    return reply
      .code(429)
      .header('retry-after', String(limit.ttlInSeconds))
      .header('x-ratelimit-limit', String(limit.max))
      .header('x-ratelimit-remaining', String(limit.remaining))
      .header('x-ratelimit-reset', String(limit.ttlInSeconds))
      .send({ error: 'rate_limited' });
  }

  app.get('/healthz', { schema: healthSchema }, () => ({ status: 'ok' }));

  app.get('/readyz', { schema: readySchema }, async (_request, reply) => {
    // Ready means "can answer correctly", which needs the sale snapshot. A
    // process that is up but has never read the sale would admit everything.
    if (!deps.saleCache.healthy) return reply.code(503).send({ status: 'not_ready' });
    return { status: 'ready' };
  });

  app.get('/api/sale', { schema: saleSchema }, async (_request, reply) => {
    const view = deps.saleCache.view();
    if (!view) return reply.code(503).send({ error: 'sale_unavailable' });

    // Served entirely from memory: no I/O on the highest-volume endpoint.
    return {
      ...view,
      // So the client can run a countdown without trusting its own clock (§9.1).
      serverTime: new Date().toISOString(),
    };
  });

  app.get<{ Params: { userId: string } }>(
    '/api/purchase/:userId',
    { schema: purchaseStatusSchema },
    async (request, reply) => {
      const { userId } = request.params;
      const order = await findOrder(deps.pool, deps.saleId, userId);
      if (!order) return reply.send({ status: 'none' });
      return reply.send({ status: 'confirmed', ...order });
    },
  );

  app.post<{ Body: { userId: string } }>(
    '/api/purchase',
    { schema: purchaseSchema },
    async (request, reply) => {
      const { userId } = request.body;

      // IP first, and only then the user: an IP-level flood should not also
      // burn the quota of whichever identifier it happens to be carrying.
      //
      // `isExceeded` is the verdict, not `isAllowed`. The latter reads like the
      // answer but is false even for a request well inside the limit — measured
      // at max=2, calls 1 and 2 both report isAllowed=false with isExceeded=false.
      const ipLimit = await byIp(request);
      if (!ipLimit.isAllowed && ipLimit.isExceeded) {
        return tooManyRequests(reply, ipLimit);
      }

      const userLimit = await byUser(request);
      if (!userLimit.isAllowed && userLimit.isExceeded) {
        return tooManyRequests(reply, userLimit);
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
