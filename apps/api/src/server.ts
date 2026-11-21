import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';

import type { ServerDeps } from './deps.js';
import { openApiDocument } from './openapi.js';
import { healthRoutes } from './routes/health.js';
import { purchaseRoutes } from './routes/purchase.js';
import { saleRoutes } from './routes/sale.js';

export type { ServerDeps } from './deps.js';

/**
 * Assembles the server: cross-cutting plugins, then the routes.
 *
 * Each route group is a Fastify plugin in `routes/`, with its schema beside it.
 * This file is deliberately kept to wiring — a handler added here would be a
 * handler nobody finds.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Fastify's ajv strips unknown properties by default, which would make
    // every `additionalProperties: false` in `routes/` silently permissive —
    // the field is dropped and the request succeeds. This is instance-wide and
    // cannot be set per route, so it lives here even though what it protects
    // is a schema elsewhere. `routes/purchase.test.ts` fails without it.
    ajv: { customOptions: { removeAdditional: false } },
  });

  // `global: false`: only the purchase endpoint is limited, and it opts in
  // itself. `/api/sale` is polled by every open tab by design, and limiting
  // health checks would make a busy instance look unhealthy.
  await app.register(rateLimit, { global: false });

  // Registered before the routes: the spec is built from the schemas declared
  // on them, so anything added afterwards would be missing from the document.
  if (deps.docs ?? true) {
    await app.register(swagger, openApiDocument);
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(healthRoutes, deps);
  await app.register(saleRoutes, deps);
  await app.register(purchaseRoutes, deps);

  return app;
}
