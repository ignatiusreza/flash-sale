/**
 * Route schemas, which do double duty.
 *
 * They are the OpenAPI document `@fastify/swagger` serves, and they are also
 * what Fastify compiles for request validation and response serialization —
 * a declared response schema is serialized by fast-json-stringify rather than
 * `JSON.stringify`, so documenting the API makes it marginally faster too.
 *
 * The catch is that serialization *strips* anything the schema does not
 * declare. A field omitted here disappears from the response rather than
 * erroring, so every property an endpoint returns must be listed.
 */

const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

const statusResponse = {
  type: 'object',
  properties: { status: { type: 'string' } },
} as const;

export const saleSchema = {
  tags: ['sale'],
  summary: 'Current sale status',
  description:
    'Served entirely from an in-process cache refreshed on a timer, so it costs no I/O per request. ' +
    'Exact remaining stock is deliberately not exposed; `availability` is coarse. ' +
    '`serverTime` lets a client run a countdown without trusting its own clock.',
  response: {
    200: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['upcoming', 'active', 'ended'] },
        availability: { type: 'string', enum: ['plenty', 'low', 'sold_out'] },
        startAt: { type: 'string', format: 'date-time' },
        endAt: { type: 'string', format: 'date-time' },
        serverTime: { type: 'string', format: 'date-time' },
      },
    },
    503: errorResponse,
  },
} as const;

export const purchaseSchema = {
  tags: ['purchase'],
  summary: 'Attempt a purchase',
  description:
    'Returns 202 once the broker has confirmed the attempt is queued — not when it succeeds. ' +
    'The outcome arrives over the WebSocket, or can be read from `GET /api/purchase/{userId}`. ' +
    'A 409 means the attempt was rejected before reaching the queue; a 503 means the queue is saturated.',
  body: {
    type: 'object',
    required: ['userId'],
    additionalProperties: false,
    properties: {
      userId: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
  response: {
    202: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued'] },
        attemptId: { type: 'string', format: 'uuid' },
      },
    },
    409: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['not_started', 'ended', 'sold_out'] },
      },
    },
    429: errorResponse,
    503: errorResponse,
  },
} as const;

export const purchaseStatusSchema = {
  tags: ['purchase'],
  summary: "Look up a user's order",
  description:
    'The reconnect source of truth. A dropped WebSocket is only cosmetic because this exists: ' +
    'the client re-syncs here and lands on the correct terminal state regardless of what it missed.',
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'string', minLength: 1, maxLength: 128 } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['none', 'confirmed'] },
        orderId: { type: 'string', format: 'uuid' },
        purchasedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const healthSchema = {
  tags: ['health'],
  summary: 'Liveness',
  description: 'Succeeds as soon as the process is up. It does not check dependencies.',
  response: { 200: statusResponse },
} as const;

export const readySchema = {
  tags: ['health'],
  summary: 'Readiness',
  description:
    'Ready only once the sale has been loaded. A process that is up but has never read the sale ' +
    'would admit every attempt, so it must not receive traffic yet.',
  response: { 200: statusResponse, 503: statusResponse },
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
