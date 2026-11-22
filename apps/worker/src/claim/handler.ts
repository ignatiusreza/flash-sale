import { saleStatusAt, type PurchaseResultEvent } from '@flash-sale/core';
import type { PurchaseAttempt, PurchaseResultsMessage } from '@flash-sale/messaging';

import { claimBatch, findExistingOrders, type ClaimResult } from './claim.js';
import type { Queryable } from '../db/pool.js';

/**
 * Rounds of claiming per batch. The claim ranks buyers against existing orders
 * read from its statement's snapshot, taken before the lock is granted, so a
 * second worker committing while it waits makes it rank a buyer who already
 * holds one: that place goes unused and the buyer after it would be told sold
 * out. Re-claiming for them fixes it; the bound only guards against a loop.
 */
const MAX_ROUNDS = 3;

/**
 * Turns one batch of attempts into one batch of outcomes.
 *
 * Losers are classified here rather than in SQL: the claim reports only *that*
 * nothing was granted, plus the window. Keeping the interpretation out of the
 * statement is deliberate — the claim stays the smallest thing that has to be
 * correct, and everything else is ordinary testable code.
 */
export async function handleBatch(
  db: Queryable,
  saleId: string,
  attempts: readonly PurchaseAttempt[],
): Promise<PurchaseResultsMessage> {
  const granted = new Map<string, string>();
  const existing = new Map<string, string>();
  let waiting = [...new Set(attempts.map((a) => a.userId))];
  let claim: ClaimResult | undefined;

  // One round with a single active consumer; another only when a buyer would
  // be told sold out while the window is open and stock remains.
  for (let round = 0; round < MAX_ROUNDS && waiting.length > 0; round++) {
    claim = await claimBatch(db, saleId, waiting);
    for (const g of claim.granted) granted.set(g.userId, g.orderId);

    // Anyone not granted might already hold an order rather than have lost —
    // the claim cannot tell those apart, since ON CONFLICT DO NOTHING grants
    // nothing either way. One lookup for the whole batch settles it.
    const ungranted = waiting.filter((id) => !granted.has(id));
    if (ungranted.length > 0) {
      for (const [userId, orderId] of await findExistingOrders(db, saleId, ungranted)) {
        existing.set(userId, orderId);
      }
    }

    waiting = claim.open && claim.remaining > 0 ? ungranted.filter((id) => !existing.has(id)) : [];
  }
  if (!claim) throw new Error('handleBatch called with an empty batch');

  const windowStatus = saleStatusAt({ startAt: claim.startAt, endAt: claim.endAt }, new Date());

  // One branch per outcome, in the order they are reached: won, already held,
  // lost on stock, too early, too late. Five branches for the five values of
  // PurchaseOutcome, so a new one cannot be added without a home here.
  const results: PurchaseResultEvent[] = attempts.map(({ attemptId, userId }) => {
    const grantedOrderId = granted.get(userId);
    const existingOrderId = existing.get(userId);

    if (grantedOrderId) {
      return { attemptId, userId, status: 'confirmed', orderId: grantedOrderId };
    } else if (existingOrderId) {
      return { attemptId, userId, status: 'already_purchased', orderId: existingOrderId };
    } else if (claim.open) {
      return { attemptId, userId, status: 'sold_out' };
    } else if (windowStatus === 'upcoming') {
      return { attemptId, userId, status: 'not_started' };
    } else {
      return { attemptId, userId, status: 'ended' };
    }
  });

  return { saleId, results };
}
