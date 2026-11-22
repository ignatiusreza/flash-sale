import { randomUUID } from 'node:crypto';

import { PublishRejected } from '@flash-sale/messaging';
import type { FastifyPluginAsync } from 'fastify';

import { admit } from '../sale/admission.js';
import type { ServerDeps } from '../deps.js';
import { errorResponse } from '../http/openapi.js';
import { findOrder } from '../orders/queries.js';
import { rateLimit } from '../http/rate-limit.js';

/** The filtered index a user's order will appear in. */
const ordersOf = (userId: string) => `/api/orders?userId=${encodeURIComponent(userId)}`;

const createSchema = {
  tags: ['orders'],
  summary: 'Create an order',
  description:
    'This is how a user purchases. The order is accepted, not yet created: 202 once the broker has ' +
    'confirmed the attempt is queued — not when it succeeds — with `Location` naming where the ' +
    'order will appear. The outcome arrives over the WebSocket, or from `GET /api/orders?userId=`. ' +
    'A 409 means the attempt was rejected before reaching the queue; a 503 means the queue is saturated.',
  body: {
    type: 'object',
    required: ['userId'],
    // Rejects rather than silently drops, but only because `server.ts` turns
    // off ajv's `removeAdditional` — that cannot be set per route.
    additionalProperties: false,
    properties: {
      userId: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
  response: {
    202: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued'] },
        attemptId: { type: 'string', format: 'uuid' },
      },
    },
    409: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['not_started', 'ended', 'sold_out'] },
      },
    },
    429: errorResponse,
    503: errorResponse,
  },
} as const;

const indexSchema = {
  tags: ['orders'],
  summary: "List a user's orders",
  description:
    'Filtered by user, and the filter is required: unfiltered, this would list every buyer to ' +
    'anyone while there is no authentication. One user holds at most one order, so the list has ' +
    'zero or one entries. This is the reconnect source of truth — a dropped WebSocket is only ' +
    'cosmetic because the client re-syncs here.',
  querystring: {
    type: 'object',
    required: ['userId'],
    additionalProperties: false,
    properties: { userId: { type: 'string', minLength: 1, maxLength: 128 } },
  },
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          orderId: { type: 'string', format: 'uuid' },
          purchasedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    429: errorResponse,
  },
} as const;

/**
 * Orders as a REST resource: `index` (filtered by user) and `create`. `new`
 * and `edit` are server-rendered forms an SPA does not need; an order cannot
 * be changed or cancelled once claimed, so there is no `update` or `destroy`;
 * and nothing needs `show` yet — it would be `GET /api/orders/:orderId`.
 */
export const orderRoutes: FastifyPluginAsync<ServerDeps> = async (app, deps) => {
  // IP first, then the user: the hook stops at the first exceeded limit, so an
  // IP-level flood does not also burn the quota of whichever identifier it
  // happens to be carrying.
  const limited = rateLimit(app, [
    { max: deps.rateLimitPerMinute },
    {
      max: deps.rateLimitPerMinute,
      keyGenerator: (request) =>
        (request.body as { userId?: string } | undefined)?.userId ?? 'anon',
    },
  ]);

  // Per address only: the lookup names a user, but any client may name any.
  const lookupLimited = rateLimit(app, [{ max: deps.lookupLimitPerMinute ?? 120 }]);

  app.get<{ Querystring: { userId: string } }>(
    '/api/orders',
    { schema: indexSchema, preHandler: lookupLimited },
    async (request) => {
      const order = await findOrder(deps.pool, deps.saleId, request.query.userId);
      return order ? [order] : [];
    },
  );

  app.post<{ Body: { userId: string } }>(
    '/api/orders',
    { schema: createSchema, preHandler: limited },
    async (request, reply) => {
      const { userId } = request.body;

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
      return reply
        .code(202)
        .header('location', ordersOf(userId))
        .send({ status: 'queued', attemptId });
    },
  );
};
