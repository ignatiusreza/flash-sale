import type { FastifyPluginAsync } from 'fastify';

import type { ServerDeps } from '../deps.js';
import { statusResponse } from '../openapi.js';

const healthSchema = {
  tags: ['health'],
  summary: 'Liveness',
  description: 'Succeeds as soon as the process is up. It does not check dependencies.',
  response: { 200: statusResponse },
} as const;

const readySchema = {
  tags: ['health'],
  summary: 'Readiness',
  description:
    'Ready only once the sale has been loaded. A process that is up but has never read the sale ' +
    'would admit every attempt, so it must not receive traffic yet.',
  response: { 200: statusResponse, 503: statusResponse },
} as const;

export const healthRoutes: FastifyPluginAsync<ServerDeps> = async (app, deps) => {
  app.get('/healthz', { schema: healthSchema }, () => ({ status: 'ok' }));

  app.get('/readyz', { schema: readySchema }, async (_request, reply) => {
    // Ready means "can answer correctly", which needs the sale snapshot. A
    // process that is up but has never read the sale would admit everything.
    if (!deps.saleCache.healthy) return reply.code(503).send({ status: 'not_ready' });
    return { status: 'ready' };
  });
};
