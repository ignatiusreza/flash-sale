import {
  saleStatusAt,
  type PurchaseAttempt,
  type PurchaseResultEvent,
  type PurchaseResultsMessage,
} from '@flash-sale/core';

import { claimBatch, findExistingOrders } from './claim.js';
import type { Queryable } from './db.js';

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

  const closedStatus = saleStatusAt({ startAt: claim.startAt, endAt: claim.endAt }, new Date());

  const results: PurchaseResultEvent[] = attempts.map(({ attemptId, userId }) => {
    const orderId = granted.get(userId) ?? existing.get(userId);
    if (orderId) {
      const status = granted.has(userId) ? 'confirmed' : 'already_purchased';
      return { attemptId, userId, status, orderId };
    }
    if (!claim.open) {
      return { attemptId, userId, status: closedStatus === 'upcoming' ? 'not_started' : 'ended' };
    }
    return { attemptId, userId, status: 'sold_out' };
  });

  return { saleId, results };
}
