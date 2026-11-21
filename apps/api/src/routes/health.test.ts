import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestServer } from '../testing/support.js';

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

describe('health', () => {
  it('is live as soon as the process is up', async () => {
    ({ app } = await createTestServer({ view: undefined }));

    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('is not ready until the sale has been loaded', async () => {
    // A process that is up but has never read the sale would admit every
    // attempt, so it must not receive traffic yet.
    ({ app } = await createTestServer({ view: undefined }));
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);

    await app.close();
    ({ app } = await createTestServer());
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });
});
