import { randomUUID } from 'node:crypto';

import { PublishRejected } from '@flash-sale/messaging';
import type { FastifyPluginAsync } from 'fastify';

import { admit } from '../sale/admission.js';
import type { ServerDeps } from '../deps.js';
import { errorResponse } from '../http/openapi.js';
import { findOrder } from '../orders/queries.js';
import { rateLimit } from '../http/rate-limit.js';

const purchaseSchema = {
  tags: ['purchase'],
  summary: 'Attempt a purchase',
  description:
    'Returns 202 once the broker has confirmed the attempt is queued — not when it succeeds. ' +
    'The outcome arrives over the WebSocket, or can be read from `GET /api/purchase/{userId}`. ' +
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

const purchaseStatusSchema = {
  tags: ['purchase'],
  summary: "Look up a user's order",
  description:
    'The reconnect source of truth. A dropped WebSocket is only cosmetic because this exists: ' +
    'the client re-syncs here and lands on the correct terminal state regardless of what it missed.',
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'string', minLength: 1, maxLength: 128 } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['none', 'confirmed'] },
        orderId: { type: 'string', format: 'uuid' },
        purchasedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const purchaseRoutes: FastifyPluginAsync<ServerDeps> = async (app, deps) => {
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
    { schema: purchaseSchema, preHandler: limited },
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
      return reply.code(202).send({ status: 'queued', attemptId });
    },
  );
};
