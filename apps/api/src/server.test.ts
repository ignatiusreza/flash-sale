import { PublishRejected } from '@flash-sale/messaging';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from './server.js';
import type { SaleCache, SaleView } from './sale-cache.js';

const WINDOW = { startAt: '2026-11-20T10:00:00.000Z', endAt: '2026-11-20T11:00:00.000Z' };

/** A cache stub: these tests are about routing and admission, not Postgres. */
function cacheOf(view: SaleView | undefined): SaleCache {
  return { view: () => view, healthy: view !== undefined } as unknown as SaleCache;
}

const activeView: SaleView = { status: 'active', availability: 'plenty', ...WINDOW };

let app: FastifyInstance;
let published: unknown[];
let publishImpl: (attempt: unknown) => Promise<void>;

async function server(options: { view?: SaleView | undefined; pool?: pg.Pool } = {}) {
  return buildServer({
    pool: options.pool ?? ({} as pg.Pool),
    saleCache: cacheOf('view' in options ? options.view : activeView),
    saleId: 'flash',
    rateLimitPerMinute: 1000,
    publish: (attempt) => publishImpl(attempt),
  });
}

beforeEach(() => {
  published = [];
  publishImpl = async (attempt) => {
    published.push(attempt);
  };
});

afterEach(async () => {
  await app?.close();
});

describe('GET /api/sale', () => {
  it('serves status and a server clock, with no exact stock count', async () => {
    app = await server();
    const response = await app.inject({ method: 'GET', url: '/api/sale' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: 'active', availability: 'plenty', ...WINDOW });
    expect(Date.parse(body.serverTime)).not.toBeNaN();
    // The count itself is deliberately not exposed (docs/PLAN.md §2.2).
    expect(JSON.stringify(body)).not.toContain('remaining');
  });

  it('returns ISO 8601 UTC instants', async () => {
    app = await server();
    const body = (await app.inject({ method: 'GET', url: '/api/sale' })).json();

    for (const field of ['startAt', 'endAt', 'serverTime']) {
      expect(body[field]).toMatch(/Z$/);
    }
  });

  it.each(['upcoming', 'ended'] as const)(
    'does not invent an availability for a %s sale',
    async (status) => {
      // The cache omits availability outside the active window — an ended sale
      // with stock left is genuinely "plenty", and saying so invites a client
      // to offer a sale nobody can buy from. `sale-cache.test.ts` covers that
      // decision; this covers the half the route owns, which is that the
      // response schema neither fabricates the field nor rejects its absence.
      app = await server({ view: { status, startAt: WINDOW.startAt, endAt: WINDOW.endAt } });
      const body = (await app.inject({ method: 'GET', url: '/api/sale' })).json();

      expect(body.status).toBe(status);
      expect(body).not.toHaveProperty('availability');
    },
  );

  it('reports availability while the sale is active', async () => {
    app = await server({ view: { ...activeView, availability: 'low' } });
    const body = (await app.inject({ method: 'GET', url: '/api/sale' })).json();

    expect(body).toMatchObject({ status: 'active', availability: 'low' });
  });

  it('is unavailable rather than wrong when the sale is not loaded', async () => {
    app = await server({ view: undefined });
    expect((await app.inject({ method: 'GET', url: '/api/sale' })).statusCode).toBe(503);
  });
});

describe('POST /api/purchase', () => {
  it('queues an attempt and answers 202 once the broker confirms', async () => {
    app = await server();
    const response = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'alice' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'queued' });
    expect(response.json().attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ saleId: 'flash', userId: 'alice' });
  });

  it('does not answer until the publish has been confirmed', async () => {
    // The gate is created up front rather than inside publishImpl: created
    // lazily, `release` is still the placeholder when the test calls it.
    let release!: () => void;
    const confirmed = new Promise<void>((resolve) => {
      release = resolve;
    });
    publishImpl = () => confirmed;
    app = await server();

    const inFlight = app.inject({ method: 'POST', url: '/api/purchase', payload: { userId: 'a' } });
    const raced = await Promise.race([inFlight, Promise.resolve('pending' as const)]);
    expect(raced).toBe('pending');

    release();
    expect((await inFlight).statusCode).toBe(202);
  });

  it.each([
    ['upcoming', 'not_started'],
    ['ended', 'ended'],
  ] as const)('rejects %s sales in-process with %s', async (status, reason) => {
    app = await server({ view: { ...activeView, status } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'alice' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: reason });
    // The point of early rejection: nothing reached the queue.
    expect(published).toHaveLength(0);
  });

  it('rejects a sold-out sale without queueing', async () => {
    app = await server({ view: { ...activeView, availability: 'sold_out' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'alice' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'sold_out' });
    expect(published).toHaveLength(0);
  });

  it('admits when the sale is not yet loaded, rather than wrongly refusing', async () => {
    // Failing open costs one queued message the worker rejects; failing closed
    // would turn a database blip into refusing real buyers (§6).
    app = await server({ view: undefined });
    const response = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'alice' },
    });

    expect(response.statusCode).toBe(202);
    expect(published).toHaveLength(1);
  });

  it('sheds load with 503 when the queue is at its bound', async () => {
    publishImpl = () => Promise.reject(new PublishRejected('queue full'));
    app = await server();

    const response = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'alice' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'busy' });
  });

  it.each([
    ['missing userId', {}],
    ['empty userId', { userId: '' }],
    ['unexpected field', { userId: 'a', admin: true }],
  ])('rejects %s with 400', async (_label, payload) => {
    app = await server();
    const response = await app.inject({ method: 'POST', url: '/api/purchase', payload });

    expect(response.statusCode).toBe(400);
    expect(published).toHaveLength(0);
  });

  it('rate limits and keeps the refused attempts off the queue', async () => {
    app = await buildServer({
      pool: {} as pg.Pool,
      saleCache: cacheOf(activeView),
      saleId: 'flash',
      rateLimitPerMinute: 2,
      publish: (attempt) => publishImpl(attempt),
    });

    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push(
        await app.inject({ method: 'POST', url: '/api/purchase', payload: { userId: 'spammer' } }),
      );
    }

    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 202)).toHaveLength(2);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    expect(published).toHaveLength(2);
  });

  it('tells a limited client when to retry instead of leaving it to guess', async () => {
    app = await buildServer({
      pool: {} as pg.Pool,
      saleCache: cacheOf(activeView),
      saleId: 'flash',
      rateLimitPerMinute: 1,
      publish: (attempt) => publishImpl(attempt),
    });

    await app.inject({ method: 'POST', url: '/api/purchase', payload: { userId: 'a' } });
    const limited = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'a' },
    });

    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Standards-compliant limit headers come from the plugin, not hand-rolled.
    expect(limited.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('limits per IP, so one flooding client cannot lock out others', async () => {
    app = await buildServer({
      pool: {} as pg.Pool,
      saleCache: cacheOf(activeView),
      saleId: 'flash',
      rateLimitPerMinute: 1,
      publish: (attempt) => publishImpl(attempt),
    });

    const flood = (userId: string, ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId },
        remoteAddress: ip,
      });

    expect((await flood('a', '10.0.0.1')).statusCode).toBe(202);
    expect((await flood('b', '10.0.0.1')).statusCode).toBe(429);
    // A different address still has its own allowance.
    expect((await flood('c', '10.0.0.2')).statusCode).toBe(202);
  });
});

describe('GET /api/purchase/:userId', () => {
  it('reports none when the user holds nothing', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.Pool;
    app = await server({ pool });

    const response = await app.inject({ method: 'GET', url: '/api/purchase/nobody' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'none' });
  });

  it('reports the existing order, which is what makes a dropped socket cosmetic', async () => {
    const created = new Date('2026-11-20T10:30:00.000Z');
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'order-1', created_at: created }] }),
    } as unknown as pg.Pool;
    app = await server({ pool });

    const response = await app.inject({ method: 'GET', url: '/api/purchase/alice' });

    expect(response.json()).toEqual({
      status: 'confirmed',
      orderId: 'order-1',
      purchasedAt: '2026-11-20T10:30:00.000Z',
    });
  });
});

describe('health', () => {
  it('is live as soon as the process is up', async () => {
    app = await server({ view: undefined });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('is not ready until the sale has been loaded', async () => {
    app = await server({ view: undefined });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);

    await app.close();
    app = await server();
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });
});
