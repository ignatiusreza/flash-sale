import { PublishRejected } from '@flash-sale/messaging';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activeView, createTestServer } from '../test-support.js';

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

describe('POST /api/purchase', () => {
  it('queues an attempt and answers 202 once the broker confirms', async () => {
    const { app: server, published } = await createTestServer();
    app = server;

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
    // The gate is created up front rather than inside publish: created lazily,
    // `release` is still the placeholder when the test calls it.
    let release!: () => void;
    const confirmed = new Promise<void>((resolve) => {
      release = resolve;
    });
    ({ app } = await createTestServer({ publish: () => confirmed }));

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
    const { app: server, published } = await createTestServer({
      view: { ...activeView, status },
    });
    app = server;

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
    const { app: server, published } = await createTestServer({
      view: { ...activeView, availability: 'sold_out' },
    });
    app = server;

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
    const { app: server, published } = await createTestServer({ view: undefined });
    app = server;

    const response = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'alice' },
    });

    expect(response.statusCode).toBe(202);
    expect(published).toHaveLength(1);
  });

  it('sheds load with 503 when the queue is at its bound', async () => {
    ({ app } = await createTestServer({
      publish: () => Promise.reject(new PublishRejected('queue full')),
    }));

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
    const { app: server, published } = await createTestServer();
    app = server;

    const response = await app.inject({ method: 'POST', url: '/api/purchase', payload });

    expect(response.statusCode).toBe(400);
    expect(published).toHaveLength(0);
  });

  describe('rate limiting', () => {
    it('refuses past the limit and keeps those attempts off the queue', async () => {
      const { app: server, published } = await createTestServer({ rateLimitPerMinute: 2 });
      app = server;

      const responses = [];
      for (let i = 0; i < 4; i++) {
        responses.push(
          await app.inject({
            method: 'POST',
            url: '/api/purchase',
            payload: { userId: 'spammer' },
          }),
        );
      }

      const codes = responses.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 202)).toHaveLength(2);
      expect(codes.filter((c) => c === 429)).toHaveLength(2);
      expect(published).toHaveLength(2);
    });

    it('tells a limited client when to retry instead of leaving it to guess', async () => {
      ({ app } = await createTestServer({ rateLimitPerMinute: 1 }));

      await app.inject({ method: 'POST', url: '/api/purchase', payload: { userId: 'a' } });
      const limited = await app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId: 'a' },
      });

      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['x-ratelimit-limit']).toBeDefined();
    });

    it('limits per IP, so one flooding client cannot lock out others', async () => {
      ({ app } = await createTestServer({ rateLimitPerMinute: 1 }));

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
});

describe('GET /api/purchase/:userId', () => {
  it('reports none when the user holds nothing', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.Pool;
    ({ app } = await createTestServer({ pool }));

    const response = await app.inject({ method: 'GET', url: '/api/purchase/nobody' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'none' });
  });

  it('reports the existing order, which is what makes a dropped socket cosmetic', async () => {
    const created = new Date('2026-11-20T10:30:00.000Z');
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'order-1', created_at: created }] }),
    } as unknown as pg.Pool;
    ({ app } = await createTestServer({ pool }));

    const response = await app.inject({ method: 'GET', url: '/api/purchase/alice' });

    expect(response.json()).toEqual({
      status: 'confirmed',
      orderId: 'order-1',
      purchasedAt: '2026-11-20T10:30:00.000Z',
    });
  });
});
