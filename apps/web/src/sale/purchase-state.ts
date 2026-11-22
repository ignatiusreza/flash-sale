import type { Availability, PurchaseResultEvent, SaleStatus } from '@flash-sale/core';

/**
 * What the page is showing about this user's purchase.
 *
 * `confirmed` and `already_purchased` collapse into one `held` state on
 * purpose. They are the same fact to a person — you have an order — and
 * distinguishing them invites the flicker described below.
 */
export type PurchaseState =
  | { readonly status: 'idle' }
  | { readonly status: 'submitting' }
  | { readonly status: 'queued'; readonly attemptId: string }
  | { readonly status: 'held'; readonly orderId: string }
  | { readonly status: 'rejected'; readonly reason: 'sold_out' | 'not_started' | 'ended' }
  | { readonly status: 'busy' }
  | { readonly status: 'rateLimited'; readonly retryAfterSeconds?: number }
  | { readonly status: 'failed'; readonly message: string };

export const idle: PurchaseState = { status: 'idle' };

/** True once there is nothing left for this user to do. */
export function isTerminal(state: PurchaseState): boolean {
  return state.status === 'held' || state.status === 'rejected';
}

/** True while a click would be pointless or harmful. */
export function isBusy(state: PurchaseState): boolean {
  return state.status === 'submitting' || state.status === 'queued';
}

/**
 * Whether a purchase can be started: someone to purchase for, a sale open
 * with stock, and nothing in flight or already settled for this user.
 */
export function canPurchase(
  state: PurchaseState,
  userId: string,
  sale: { readonly status: SaleStatus; readonly availability?: Availability } | undefined,
): boolean {
  return (
    Boolean(userId) &&
    sale?.status === 'active' &&
    sale.availability !== 'sold_out' &&
    !isBusy(state) &&
    !isTerminal(state)
  );
}

/**
 * Folds an incoming result into the current state.
 *
 * Results arrive per *user*, not per attempt, so a tab receives outcomes for
 * attempts other tabs made (see the README). Two rules follow:
 *
 * 1. **An event carrying an `orderId` always wins.** It is proof this user
 *    holds an order, whichever tab's attempt produced it, and it is why the
 *    client keys on `orderId` rather than on which attempt was `confirmed`.
 *    Without this, a second tab's `already_purchased` would look like a
 *    different outcome from the first tab's `confirmed`.
 *
 * 2. **A rejection only applies to our own attempt.** Another tab being told
 *    `sold_out` says nothing about ours, and letting it through would undo a
 *    state this tab legitimately reached.
 */
export function applyResult(
  state: PurchaseState,
  event: PurchaseResultEvent,
  ourAttemptId: string | undefined,
): PurchaseState {
  if (event.orderId) return { status: 'held', orderId: event.orderId };

  if (event.attemptId !== ourAttemptId) return state;

  switch (event.status) {
    case 'sold_out':
    case 'not_started':
    case 'ended':
      return { status: 'rejected', reason: event.status };
    default:
      // `confirmed`/`already_purchased` without an orderId should not happen;
      // leaving the state alone is better than inventing a terminal one.
      return state;
  }
}

/** Maps an API response to a state, for the paths that never reach the queue. */
export function applyResponse(status: number, body: unknown): PurchaseState {
  const payload = (body ?? {}) as { status?: string; attemptId?: string; error?: string };

  if (status === 202 && payload.attemptId) {
    return { status: 'queued', attemptId: payload.attemptId };
  }
  if (status === 409 && payload.status) {
    return { status: 'rejected', reason: payload.status as 'sold_out' | 'not_started' | 'ended' };
  }
  if (status === 429) return { status: 'rateLimited' };
  if (status === 503) return { status: 'busy' };
  return { status: 'failed', message: payload.error ?? `request failed (${status})` };
}
