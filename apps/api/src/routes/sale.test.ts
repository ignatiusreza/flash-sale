import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { activeView, createTestServer, WINDOW } from '../testing/support.js';

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

describe('GET /api/sale', () => {
  it('serves status and a server clock, with no exact stock count', async () => {
    ({ app } = await createTestServer());
    const response = await app.inject({ method: 'GET', url: '/api/sale' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ status: 'active', availability: 'plenty', ...WINDOW });
    expect(Date.parse(body.serverTime)).not.toBeNaN();
    // The count itself is deliberately not exposed (docs/PLAN.md §2.2).
    expect(JSON.stringify(body)).not.toContain('remaining');
  });

  it('returns ISO 8601 UTC instants', async () => {
    ({ app } = await createTestServer());
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
      ({ app } = await createTestServer({
        view: { status, startAt: WINDOW.startAt, endAt: WINDOW.endAt },
      }));
      const body = (await app.inject({ method: 'GET', url: '/api/sale' })).json();

      expect(body.status).toBe(status);
      expect(body).not.toHaveProperty('availability');
    },
  );

  it('reports availability while the sale is active', async () => {
    ({ app } = await createTestServer({ view: { ...activeView, availability: 'low' } }));
    const body = (await app.inject({ method: 'GET', url: '/api/sale' })).json();

    expect(body).toMatchObject({ status: 'active', availability: 'low' });
  });

  it('is unavailable rather than wrong when the sale is not loaded', async () => {
    ({ app } = await createTestServer({ view: undefined }));

    expect((await app.inject({ method: 'GET', url: '/api/sale' })).statusCode).toBe(503);
  });
});
