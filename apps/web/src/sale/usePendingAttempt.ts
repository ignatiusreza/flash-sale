import type { Availability, SaleStatus } from '@flash-sale/core';
import { useEffect, type Dispatch, type SetStateAction } from 'react';

import { findOrder } from './api.js';
import { clearPending, loadPending, savePending } from './pending-attempt.js';
import {
  idle,
  isTerminal,
  livePending,
  PENDING_TTL_MS,
  restoredOutcome,
  type PurchaseState,
} from './purchase-state.js';

type Sale = { readonly status: SaleStatus; readonly availability?: Availability } | undefined;

/** True while `state` is still the restored attempt `attemptId`. */
function stillRestored(state: PurchaseState, attemptId: string): boolean {
  return state.status === 'queued' && state.restored === true && state.attemptId === attemptId;
}

/**
 * Keeps an undecided attempt across a refresh. The queue holds requests, not
 * anything a page can look up, so without this a reloaded page offers Buy
 * again mid-purchase and cannot recognise the attempt's result as its own.
 *
 * It remembers the attempt until it is decided, restores it on arrival (and
 * for each new identity), settles one whose result was missed, and lets one
 * go that nobody has decided within `PENDING_TTL_MS`.
 */
export function usePendingAttempt(
  userId: string,
  purchaseState: PurchaseState,
  sale: Sale,
  setPurchaseState: Dispatch<SetStateAction<PurchaseState>>,
): void {
  // Remember the attempt until it is decided.
  useEffect(() => {
    if (!userId) return;
    if (purchaseState.status === 'queued') {
      // Keep the original time across restores, or it would never expire.
      if (loadPending(userId)?.attemptId !== purchaseState.attemptId) {
        savePending(userId, { attemptId: purchaseState.attemptId, since: Date.now() });
      }
    } else if (isTerminal(purchaseState)) {
      clearPending(userId);
    }
  }, [userId, purchaseState]);

  // On arrival and for each new identity: start from what this user left
  // pending, or from nothing. Let it go once it is too old to wait for.
  useEffect(() => {
    if (!userId) return;

    const pending = livePending(loadPending(userId), Date.now());
    if (!pending) {
      clearPending(userId);
      setPurchaseState(idle);
      return;
    }
    setPurchaseState({ status: 'queued', attemptId: pending.attemptId, restored: true });

    let cancelled = false;
    const expiry = setTimeout(
      () => {
        void findOrder(userId).then((orderId) => {
          if (cancelled) return;
          if (!orderId) clearPending(userId);
          setPurchaseState((current) =>
            stillRestored(current, pending.attemptId)
              ? orderId
                ? { status: 'held', orderId }
                : idle
              : current,
          );
        });
      },
      pending.since + PENDING_TTL_MS - Date.now(),
    );

    return () => {
      cancelled = true;
      clearTimeout(expiry);
    };
  }, [userId, setPurchaseState]);

  // Once the sale has ended or sold out, a restored attempt without an order
  // has failed, whether or not its result ever reached a page. Confirmed with
  // a fresh lookup first: it may have won before the sale sold out.
  const restoredId =
    purchaseState.status === 'queued' && purchaseState.restored
      ? purchaseState.attemptId
      : undefined;
  const outcome = restoredOutcome(sale);
  const failedBecause = outcome?.status === 'rejected' ? outcome.reason : undefined;
  useEffect(() => {
    if (!userId || !restoredId || !failedBecause) return;
    let cancelled = false;

    void findOrder(userId).then((orderId) => {
      if (cancelled) return;
      setPurchaseState((current) =>
        stillRestored(current, restoredId)
          ? orderId
            ? { status: 'held', orderId }
            : { status: 'rejected', reason: failedBecause }
          : current,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [userId, restoredId, failedBecause, setPurchaseState]);
}
