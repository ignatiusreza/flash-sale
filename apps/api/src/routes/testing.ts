import type { FastifyPluginAsync } from 'fastify';

import type { ServerDeps } from '../deps.js';

const resetSchema = {
  // Never in the OpenAPI document, even when registered: it is not an API.
  hide: true,
  body: {
    type: 'object',
    required: ['stock', 'startsInMs', 'durationMs'],
    additionalProperties: false,
    properties: {
      stock: { type: 'integer', minimum: 0 },
      // Relative to the server's clock, so a test never depends on its own
      // clock agreeing with the server's. Negative means already started.
      startsInMs: { type: 'integer' },
      durationMs: { type: 'integer', minimum: 1 },
    },
  },
} as const;

/**
 * E2E-only: wipes the sale's orders and reseeds it, so each spec starts from a
 * sale with known stock and window (docs/PLAN.md §11). Registered only when
 * the API runs as `APP_ENV=e2e` (`testEndpointsEnabled` in config.ts).
 */
export const testRoutes: FastifyPluginAsync<ServerDeps> = async (app, deps) => {
  app.post<{ Body: { stock: number; startsInMs: number; durationMs: number } }>(
    '/api/test/sale',
    { schema: resetSchema },
    async (request) => {
      const { stock, startsInMs, durationMs } = request.body;

      await deps.pool.query(
        `WITH cleared AS (DELETE FROM orders WHERE sale_id = $1)
         INSERT INTO sales (id, total_stock, remaining, start_at, end_at)
         VALUES ($1, $2, $2,
                 now() + $3 * interval '1 millisecond',
                 now() + ($3 + $4) * interval '1 millisecond')
         ON CONFLICT (id) DO UPDATE SET
           total_stock = EXCLUDED.total_stock,
           remaining = EXCLUDED.remaining,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at`,
        [deps.saleId, stock, startsInMs, durationMs],
      );

      // Without this the cache serves the previous sale for up to a refresh
      // interval, and the spec that just seeded it sees the old one.
      await deps.saleCache.refresh();
      return deps.saleCache.view();
    },
  );
};
