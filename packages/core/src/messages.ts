/**
 * Wire contracts between the API, the worker and the browser.
 *
 * Types only — no transport. `packages/messaging` owns the AMQP code, because
 * this package is bundled into the web client and must not pull in Node.
 */
import type { PurchaseOutcome } from './index.js';

/** The attempts queue carries *requests*, not decisions. */
export const ATTEMPTS_QUEUE = 'purchase.attempts';

/** Results, sellout and presence fan out to every API instance. */
export const EVENTS_EXCHANGE = 'flash-sale.events';

export const ROUTING_KEY_RESULTS = 'purchase.results';

/**
 * Queue arguments. Quorum for replication across the cluster (docs/PLAN.md
 * §5.1); single-active-consumer because the serialization the whole design
 * rests on is one consumer processing in order; bounded length so saturation
 * becomes a clean 503 rather than unbounded memory and latency.
 */
export const ATTEMPTS_QUEUE_ARGS = {
  'x-queue-type': 'quorum',
  'x-single-active-consumer': true,
  'x-max-length': 100_000,
  'x-overflow': 'reject-publish',
} as const;

export interface PurchaseAttempt {
  readonly attemptId: string;
  readonly saleId: string;
  readonly userId: string;
  /** ISO 8601, UTC (§9.1). */
  readonly requestedAt: string;
}

export interface PurchaseResultEvent {
  readonly attemptId: string;
  readonly userId: string;
  readonly status: PurchaseOutcome;
  readonly orderId?: string;
}

/**
 * One message carries a whole batch's outcomes. Per-attempt messages would put
 * the fan-out cost back on the hot path (docs/PLAN.md §4.2).
 */
export interface PurchaseResultsMessage {
  readonly saleId: string;
  readonly results: readonly PurchaseResultEvent[];
}
