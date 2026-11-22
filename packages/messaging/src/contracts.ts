/**
 * Broker-side contracts: topology names, queue arguments, and the message
 * shapes that never leave the server.
 *
 * These live here rather than in `core` specifically because `core` is a
 * dependency of the web client. Queue names and bounds are not secrets, but
 * `x-max-length` tells anyone who reads it exactly how much load is needed to
 * trip load shedding, and broker configuration has no business in a bundle
 * served to browsers. `apps/web` does not depend on this package, so it cannot
 * reach any of it — that dependency boundary is the guard.
 */

/** The attempts queue carries *requests*, not decisions. */
export const ATTEMPTS_QUEUE = 'purchase.attempts';

/** Results, sellout and presence fan out to every API instance. */
export const EVENTS_EXCHANGE = 'flash-sale.events';

export const ROUTING_KEY_RESULTS = 'purchase.results';

/**
 * Quorum for replication across the cluster (docs/PLAN.md §5.1);
 * single-active-consumer because the serialization the whole design rests on is
 * one consumer processing in order; bounded length so saturation becomes a
 * clean 503 rather than unbounded memory and latency.
 *
 * The delivery limit is RabbitMQ 4's default, made explicit because what
 * happens past it is not: without a dead-letter target the broker drops the
 * message. Accepted attempts must never vanish, so they are dead-lettered,
 * at-least-once, to a queue of their own (see `assertTopology`). A delivery is
 * only spent when a worker dies holding a batch; a failing claim is retried in
 * place (see `startBatchConsumer`).
 */
export const ATTEMPTS_QUEUE_ARGS = {
  'x-queue-type': 'quorum',
  'x-single-active-consumer': true,
  'x-max-length': 100_000,
  'x-overflow': 'reject-publish',
  'x-delivery-limit': 20,
  'x-dead-letter-strategy': 'at-least-once',
} as const;

/** Published by the API, consumed by the worker. The browser never sees one. */
export interface PurchaseAttempt {
  readonly attemptId: string;
  readonly saleId: string;
  readonly userId: string;
  /** ISO 8601, UTC (§9.1). */
  readonly requestedAt: string;
}

/**
 * One message carries a whole batch's outcomes; per-attempt messages would put
 * the fan-out cost back on the hot path (§4.2). The API unpacks this and
 * pushes the individual events to the sockets it holds, so this envelope is
 * server-side only — `PurchaseResultEvent` in `core` is the browser-facing half.
 */
export interface PurchaseResultsMessage {
  readonly saleId: string;
  readonly results: readonly import('@flash-sale/core').PurchaseResultEvent[];
}

export const ROUTING_KEY_PRESENCE = 'presence.count';

/**
 * How many sockets one API instance currently holds.
 *
 * Presence is aggregated rather than exact: each instance announces its own
 * count on a timer, and every instance sums what it has heard. Exact
 * per-connection accounting broadcast to everyone would be O(N²), and the
 * number is decorative — "X people are looking at this" does not need to be
 * right to the person.
 */
export interface PresenceMessage {
  readonly instanceId: string;
  readonly connections: number;
  /** ISO 8601, UTC. Lets receivers expire instances that stopped announcing. */
  readonly at: string;
}
