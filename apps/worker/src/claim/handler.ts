import { saleStatusAt, type PurchaseResultEvent } from '@flash-sale/core';
import type { PurchaseAttempt, PurchaseResultsMessage } from '@flash-sale/messaging';

import { claimBatch, findExistingOrders } from './claim.js';
import type { Queryable } from '../db/pool.js';

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
  const claim = await claimBatch(
    db,
    saleId,
    attempts.map((a) => a.userId),
  );

  const granted = new Map(claim.granted.map((g) => [g.userId, g.orderId]));

  // Anyone not granted might already hold an order rather than have lost — the
  // claim cannot tell those apart, since ON CONFLICT DO NOTHING grants nothing
  // either way. One lookup for the whole batch settles it.
  const ungranted = attempts.map((a) => a.userId).filter((id) => !granted.has(id));
  const existing =
    ungranted.length > 0
      ? await findExistingOrders(db, saleId, ungranted)
      : new Map<string, string>();

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
