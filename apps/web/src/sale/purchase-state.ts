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
  | {
      readonly status: 'queued';
      readonly attemptId: string;
      /**
       * Restored after a refresh rather than sent by this page: its result
       * may have been missed, so only it may be settled from the sale.
       */
      readonly restored?: true;
    }
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
 * The attempt this page is waiting on, whose rejection would be ours. Only
 * while queued: before the 202 nobody knows it (`applyOwnResponse` covers
 * that window), and once decided there is nothing left to wait for.
 */
export function attemptOf(state: PurchaseState): string | undefined {
  return state.status === 'queued' ? state.attemptId : undefined;
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
 * An attempt this browser sent and has not yet seen decided, remembered so a
 * refresh does not forget it: the queue holds requests, not anything the page
 * can look up, so without this a reloaded page offers Buy again mid-purchase.
 */
export interface PendingAttempt {
  readonly attemptId: string;
  /** Epoch milliseconds, when the attempt was accepted. */
  readonly since: number;
}

/**
 * How long a remembered attempt is trusted. Real waits are seconds; past this,
 * its result was missed — the page was closed when it arrived — and the order
 * lookup has already said it did not succeed.
 */
export const PENDING_TTL_MS = 2 * 60_000;

/** The remembered attempt, if it is still young enough to wait for. */
export function livePending(
  pending: PendingAttempt | undefined,
  now: number,
): PendingAttempt | undefined {
  return pending && now - pending.since < PENDING_TTL_MS ? pending : undefined;
}

/**
 * The outcome a restored attempt must have had, given that the user holds no
 * order: once the sale has ended or sold out it can no longer succeed.
 * Undefined while it still could.
 *
 * Only for attempts restored after a refresh, whose result may have been
 * missed, and only after a lookup has found no order. A live attempt gets its
 * result over the socket, and the "sold out" push can arrive just before the
 * result of the purchase that took the last unit.
 */
export function restoredOutcome(
  sale: { readonly status: SaleStatus; readonly availability?: Availability } | undefined,
): PurchaseState | undefined {
  if (sale?.status === 'ended') return { status: 'rejected', reason: 'ended' };
  if (sale?.status === 'active' && sale.availability === 'sold_out') {
    return { status: 'rejected', reason: 'sold_out' };
  }
  return undefined;
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

/**
 * Folds the response to our own POST into the state, given the results that
 * arrived while it was in flight.
 *
 * The worker can settle an attempt and push its result before the 202 that
 * names it reaches the client — measured within 0–2 ms of each other locally.
 * So the response must never regress a state a result already settled, and a
 * rejection that arrived before we knew our attempt id has to be matched up
 * once we do; otherwise the page sits on "queued" for an attempt long decided.
 */
export function applyOwnResponse(
  state: PurchaseState,
  response: PurchaseState,
  arrivedEarly: readonly PurchaseResultEvent[],
): PurchaseState {
  if (isTerminal(state)) return state;
  if (response.status !== 'queued') return response;

  const ours = arrivedEarly.find((event) => event.attemptId === response.attemptId);
  return ours ? applyResult(response, ours, response.attemptId) : response;
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
