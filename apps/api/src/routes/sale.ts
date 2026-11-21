import type { FastifyPluginAsync } from 'fastify';

import type { ServerDeps } from '../deps.js';
import { errorResponse } from '../openapi.js';

const saleSchema = {
  tags: ['sale'],
  summary: 'Current sale status',
  description:
    'Served entirely from an in-process cache refreshed on a timer, so it costs no I/O per request. ' +
    'Exact remaining stock is deliberately not exposed; `availability` is coarse, and is **present ' +
    'only while `status` is `active`** — an ended sale with units left is not "plenty available", ' +
    'it is simply over. ' +
    '`serverTime` lets a client run a countdown without trusting its own clock.',
  response: {
    200: {
      type: 'object',
      required: ['status', 'startAt', 'endAt', 'serverTime'],
      properties: {
        status: { type: 'string', enum: ['upcoming', 'active', 'ended'] },
        availability: {
          type: 'string',
          enum: ['plenty', 'low', 'sold_out'],
          description: 'Only present while the sale is active.',
        },
        startAt: { type: 'string', format: 'date-time' },
        endAt: { type: 'string', format: 'date-time' },
        serverTime: { type: 'string', format: 'date-time' },
      },
    },
    503: errorResponse,
  },
} as const;

export const saleRoutes: FastifyPluginAsync<ServerDeps> = async (app, deps) => {
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
};
