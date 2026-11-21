/**
 * The OpenAPI document, and the schema fragments shared across routes.
 *
 * Each route's own schema lives beside the route it describes, so the two
 * cannot drift and neither file grows into a catch-all. Only what is genuinely
 * shared is here.
 *
 * Note that a declared response schema is also what Fastify serializes with,
 * and serialization *strips* anything the schema does not list. A property
 * omitted from a schema disappears from the response rather than erroring.
 */

export const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

export const statusResponse = {
  type: 'object',
  properties: { status: { type: 'string' } },
} as const;

export const openApiDocument = {
  openapi: {
    info: {
      title: 'Flash Sale API',
      version: '0.1.0',
      description:
        'A flash sale for a single product with limited stock.\n\n' +
        'Purchases are **asynchronous**: `POST /api/purchase` returns 202 once the attempt is ' +
        'durably queued, and the outcome is pushed over a WebSocket. That is what lets the system ' +
        'answer under load without ever overselling — see `docs/PLAN.md`.',
    },
    tags: [
      { name: 'sale', description: 'Sale status' },
      { name: 'purchase', description: 'Attempting and checking purchases' },
      { name: 'health', description: 'Liveness and readiness' },
    ],
  },
};
