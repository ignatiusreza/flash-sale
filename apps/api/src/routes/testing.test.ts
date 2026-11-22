import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SaleCache } from '../sale/cache.js';
import { activeView, createTestServer } from '../testing/support.js';

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

const reset = { stock: 2, startsInMs: -1000, durationMs: 60_000 };

describe('POST /api/test/sale', () => {
  // The whole safety of this endpoint is that it does not exist by default.
  it('does not exist unless enabled', async () => {
    const query = vi.fn();
    ({ app } = await createTestServer({ pool: { query } as unknown as pg.Pool }));

    const response = await app.inject({ method: 'POST', url: '/api/test/sale', payload: reset });

    expect(response.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('reseeds the sale, then refreshes the cache before answering', async () => {
    const calls: string[] = [];
    const query = vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: [] }>>(async () => {
      calls.push('query');
      return { rows: [] };
    });
    const saleCache = {
      refresh: vi.fn(async () => {
        calls.push('refresh');
      }),
      view: () => activeView,
      healthy: true,
    } as unknown as SaleCache;
    ({ app } = await createTestServer({
      pool: { query } as unknown as pg.Pool,
      saleCache,
      enableTestEndpoints: true,
    }));

    const response = await app.inject({ method: 'POST', url: '/api/test/sale', payload: reset });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(activeView);
    // The refresh must follow the write, or the spec sees the previous sale.
    expect(calls).toEqual(['query', 'refresh']);
    expect(query.mock.calls[0]?.[1]).toEqual(['flash', 2, -1000, 60_000]);
  });

  it('rejects a reset it cannot honour', async () => {
    ({ app } = await createTestServer({ enableTestEndpoints: true }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/sale',
      payload: { ...reset, stock: -1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('stays out of the OpenAPI document even when enabled', async () => {
    ({ app } = await createTestServer({ enableTestEndpoints: true }));
    await app.ready();

    expect(Object.keys(app.swagger().paths ?? {})).not.toContain('/api/test/sale');
  });
});
