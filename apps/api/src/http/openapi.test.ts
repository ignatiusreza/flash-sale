import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { activeView, cacheOf } from '../testing/support.js';

let app: FastifyInstance;

/**
 * Builds directly rather than through `createTestServer`, because the point
 * here is the `docs` flag, which that helper deliberately leaves at default.
 */
function server(docs = true) {
  return buildServer({
    pool: {} as pg.Pool,
    saleCache: cacheOf(activeView),
    saleId: 'flash',
    rateLimitPerMinute: 1000,
    publish: async () => {},
    docs,
  });
}

afterEach(async () => {
  await app?.close();
});

describe('OpenAPI document', () => {
  it('describes every public route', async () => {
    app = await server();
    // The spec is assembled during boot, so it is only complete after ready().
    await app.ready();
    const spec = app.swagger();

    expect(Object.keys(spec.paths ?? {}).sort()).toEqual([
      '/api/purchase',
      '/api/purchase/{userId}',
      '/api/sale',
      '/healthz',
      '/readyz',
    ]);
  });

  it('documents the outcomes a client has to handle, not just the happy path', async () => {
    app = await server();
    await app.ready();
    const purchase = app.swagger().paths?.['/api/purchase']?.post;

    expect(Object.keys(purchase?.responses ?? {}).sort()).toEqual(['202', '409', '429', '503']);
    // The three reasons an attempt is refused before it reaches the queue.
    const conflict = purchase?.responses?.['409'];
    const status = (
      conflict as {
        content?: Record<string, { schema?: { properties?: Record<string, { enum?: string[] }> } }>;
      }
    )?.content?.['application/json']?.schema?.properties?.status;
    expect(status?.enum).toEqual(['not_started', 'ended', 'sold_out']);
  });

  it('serves the UI', async () => {
    app = await server();
    const response = await app.inject({ method: 'GET', url: '/docs' });

    // The UI redirects to its trailing-slash index.
    expect([200, 302]).toContain(response.statusCode);
  });

  it('can be turned off, so it need not ship to production', async () => {
    app = await server(false);
    const response = await app.inject({ method: 'GET', url: '/docs' });

    expect(response.statusCode).toBe(404);
  });
});

describe('response schemas', () => {
  // Declaring a response schema makes Fastify serialize with
  // fast-json-stringify, which *strips* undeclared properties rather than
  // erroring. A field missing from the schema silently vanishes from the API,
  // so these assert the payloads survive the round trip intact.
  it('keeps every field of the sale payload', async () => {
    app = await server();
    const body = (await app.inject({ method: 'GET', url: '/api/sale' })).json();

    expect(Object.keys(body).sort()).toEqual([
      'availability',
      'endAt',
      'serverTime',
      'startAt',
      'status',
    ]);
  });

  it('keeps the attemptId on a queued purchase', async () => {
    app = await server();
    const body = (
      await app.inject({ method: 'POST', url: '/api/purchase', payload: { userId: 'alice' } })
    ).json();

    expect(body.status).toBe('queued');
    expect(body.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
