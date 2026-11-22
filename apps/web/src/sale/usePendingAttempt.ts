import type { Availability, SaleStatus } from '@flash-sale/core';
import { useEffect, type Dispatch, type SetStateAction } from 'react';

import { lookupOrderUntilKnown } from './api.js';
import { clearPending, loadPending, savePending } from './pending-attempt.js';
import {
  idle,
  livePending,
  outcomeFromSale,
  PENDING_TTL_MS,
  type PurchaseState,
} from './purchase-state.js';

type Sale = { readonly status: SaleStatus; readonly availability?: Availability } | undefined;

/**
 * Where a page starts for `userId`: waiting on the attempt they left pending,
 * or from nothing. Read during render, when the identity is first known or
 * changes, so no effect ever sees one user's state under another's name.
 */
export function initialPurchaseState(userId: string): PurchaseState {
  const pending = userId ? livePending(loadPending(userId), Date.now()) : undefined;
  return pending ? { status: 'queued', attemptId: pending.attemptId } : idle;
}

/** True while `state` is still waiting on `attemptId`. */
function stillWaiting(state: PurchaseState, attemptId: string): boolean {
  return state.status === 'queued' && state.attemptId === attemptId;
}

/**
 * Keeps an undecided attempt across a refresh, and makes sure every attempt
 * is eventually decided on the page even if its result never arrives.
 *
 * The queue holds requests, not anything a page can look up, so without this a
 * reloaded page offers Buy again mid-purchase and cannot recognise the
 * attempt's result as its own. And a result pushed while the socket was down
 * is gone: the order lookup on reconnect recovers a win, but not a rejection.
 * So a waiting attempt — restored or sent by this page — is settled from the
 * sale once it can no longer succeed, and let go after `PENDING_TTL_MS`.
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
    } else if (purchaseState.status === 'held' || purchaseState.status === 'rejected') {
      clearPending(userId);
    }
  }, [userId, purchaseState]);

  const waitingId = purchaseState.status === 'queued' ? purchaseState.attemptId : undefined;

  // Let go of an attempt nobody has decided within the TTL: its result was
  // missed, and the lookup says whether it won.
  useEffect(() => {
    if (!userId || !waitingId) return;
    const abort = new AbortController();
    const since = loadPending(userId)?.since ?? Date.now();

    const expiry = setTimeout(
      () => {
        void lookupOrderUntilKnown(userId, abort.signal).then((lookup) => {
          if (!lookup) return;
          if (lookup.status === 'none') clearPending(userId);
          setPurchaseState((current) =>
            stillWaiting(current, waitingId)
              ? lookup.status === 'held'
                ? { status: 'held', orderId: lookup.orderId }
                : idle
              : current,
          );
        });
      },
      since + PENDING_TTL_MS - Date.now(),
    );

    return () => {
      abort.abort();
      clearTimeout(expiry);
    };
  }, [userId, waitingId, setPurchaseState]);

  // Once the sale has ended or sold out, a waiting attempt without an order
  // has failed, whether or not its result ever reached a page. Confirmed with
  // a fresh lookup first, which must actually answer: it may have won the
  // last unit, and a lookup that failed knows nothing either way.
  const outcome = outcomeFromSale(sale);
  const failedBecause = outcome?.status === 'rejected' ? outcome.reason : undefined;
  useEffect(() => {
    if (!userId || !waitingId || !failedBecause) return;
    const abort = new AbortController();

    void lookupOrderUntilKnown(userId, abort.signal).then((lookup) => {
      if (!lookup) return;
      setPurchaseState((current) =>
        stillWaiting(current, waitingId)
          ? lookup.status === 'held'
            ? { status: 'held', orderId: lookup.orderId }
            : { status: 'rejected', reason: failedBecause }
          : current,
      );
    });

    return () => {
      abort.abort();
    };
  }, [userId, waitingId, failedBecause, setPurchaseState]);
}
