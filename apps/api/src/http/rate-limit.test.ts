import rateLimitPlugin from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { rateLimit, type LimitSpec } from './rate-limit.js';

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

/** A bare server with the hook on one route, so these test the hook alone. */
async function serverWith(specs: readonly LimitSpec[]): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(rateLimitPlugin, { global: false });
  instance.post('/t', { preHandler: rateLimit(instance, specs) }, async () => ({ ok: true }));
  return instance;
}

const post = (instance: FastifyInstance, userId: string, ip = '10.0.0.1') =>
  instance.inject({ method: 'POST', url: '/t', payload: { userId }, remoteAddress: ip });

const byUser: LimitSpec['keyGenerator'] = (request) =>
  (request.body as { userId?: string } | undefined)?.userId ?? 'anon';

describe('rateLimit hook', () => {
  it('allows up to the limit, then refuses', async () => {
    app = await serverWith([{ max: 2 }]);

    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post(app, 'a')).statusCode);

    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it('tells a refused client when to retry', async () => {
    app = await serverWith([{ max: 1 }]);
    await post(app, 'a');

    const refused = await post(app, 'a');

    expect(refused.json()).toEqual({ error: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.headers['x-ratelimit-limit']).toBe('1');
    expect(refused.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('applies every limit, not just the first', async () => {
    // The reason this hook exists: `app.rateLimit()` supports only one hook per
    // route and silently ignores a second, so two dimensions need composing.
    app = await serverWith([{ max: 100 }, { max: 2, keyGenerator: byUser }]);

    const codes = [];
    // A fresh IP each time, so only the per-user limit can bite.
    for (let i = 0; i < 4; i++) codes.push((await post(app, 'alice', `10.1.1.${i}`)).statusCode);

    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it('keeps separate keys independent', async () => {
    app = await serverWith([{ max: 1, keyGenerator: byUser }]);

    expect((await post(app, 'alice')).statusCode).toBe(200);
    expect((await post(app, 'bob')).statusCode).toBe(200);
    expect((await post(app, 'alice')).statusCode).toBe(429);
  });

  it('stops at the first exceeded limit, leaving later quotas untouched', async () => {
    // Order matters: a flood on the first dimension must not also consume the
    // allowance of the ones behind it.
    app = await serverWith([{ max: 1 }, { max: 3, keyGenerator: byUser }]);

    // Two requests from one IP: the second is refused by the IP limit.
    expect((await post(app, 'alice')).statusCode).toBe(200);
    expect((await post(app, 'alice')).statusCode).toBe(429);
    expect((await post(app, 'alice')).statusCode).toBe(429);

    // alice spent one user token, not three — a different IP proves it.
    expect((await post(app, 'alice', '10.0.0.2')).statusCode).toBe(200);
    expect((await post(app, 'alice', '10.0.0.3')).statusCode).toBe(200);
    expect((await post(app, 'alice', '10.0.0.4')).statusCode).toBe(429);
  });

  it('does nothing when given no limits', async () => {
    app = await serverWith([]);

    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(app, 'a')).statusCode);

    expect(codes.every((c) => c === 200)).toBe(true);
  });
});
