/**
 * Event shapes the browser receives.
 *
 * This package is bundled into the web client, so only what the client
 * legitimately needs belongs here. Broker topology — queue names, queue
 * arguments, the batch envelope the API unpacks — lives in
 * `packages/messaging`, which the web app does not depend on.
 */
import type { PurchaseOutcome } from './index.js';

/** Pushed to a single user's socket once their attempt has been settled. */
export interface PurchaseResultEvent {
  readonly attemptId: string;
  readonly userId: string;
  readonly status: PurchaseOutcome;
  readonly orderId?: string;
}
