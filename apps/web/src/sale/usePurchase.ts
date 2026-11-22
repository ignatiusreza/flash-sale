import type { Availability, PurchaseResultEvent, SaleStatus } from '@flash-sale/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { useSocketEvent } from '../realtime/useSocketEvent.js';
import { findOrder, submitPurchase } from './api.js';
import { clearPending, loadPending, savePending } from './pending-attempt.js';
import {
  applyOwnResponse,
  applyResult,
  idle,
  isTerminal,
  livePending,
  PENDING_TTL_MS,
  restoredOutcome,
  type PurchaseState,
} from './purchase-state.js';

type Sale = { readonly status: SaleStatus; readonly availability?: Availability } | undefined;

/**
 * Where this user's purchasing stands, and the action that starts it.
 *
 * The state has four sources that must agree: the response to our own
 * attempt, results pushed over the socket, an order found on arrival, and an
 * attempt left pending by an earlier page — a refresh mid-purchase.
 */
export function usePurchase(
  userId: string,
  socket: Socket,
  sale: Sale,
): { purchaseState: PurchaseState; purchase: () => Promise<void> } {
  const [purchaseState, setPurchaseState] = useState<PurchaseState>(idle);
  // Refs, not state: they decide how results are read, never what renders.
  const attemptRef = useRef<string | undefined>(undefined);
  // Results that arrive while our POST is in flight, before its 202 tells us
  // which attempt is ours (see `applyOwnResponse`). Undefined when idle.
  const arrivedEarlyRef = useRef<PurchaseResultEvent[] | undefined>(undefined);
  // An attempt restored from an earlier page, whose result may have been
  // missed while no page was open to receive it.
  const restoredRef = useRef<string | undefined>(undefined);

  // The socket may report an order this tab never asked for — another tab, or
  // an earlier visit. Folding it in is what keeps tabs agreeing.
  useSocketEvent<PurchaseResultEvent>(socket, 'purchase:result', (result) => {
    // Only while `purchase()` is waiting on its POST; it reads these back.
    arrivedEarlyRef.current?.push(result);
    setPurchaseState((current) => applyResult(current, result, attemptRef.current));
  });

  // Remember an attempt until it is decided, so a refresh does not forget it.
  useEffect(() => {
    if (!userId) return;
    if (purchaseState.status === 'queued') {
      // Keep the original time across restores, or it would never expire.
      if (loadPending(userId)?.attemptId !== purchaseState.attemptId) {
        savePending(userId, { attemptId: purchaseState.attemptId, since: Date.now() });
      }
    } else if (isTerminal(purchaseState)) {
      clearPending(userId);
      restoredRef.current = undefined;
    }
  }, [userId, purchaseState]);

  // On arrival — and for each new identity — start from what this user left
  // pending, then ask whether they already hold an order. Ask again after
  // every reconnect, because a result pushed while the socket was down is gone
  // for good while the order it announced is not (docs/PLAN.md §5).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const pending = livePending(loadPending(userId), Date.now());
    attemptRef.current = pending?.attemptId;
    restoredRef.current = pending?.attemptId;
    if (pending) {
      setPurchaseState({ status: 'queued', attemptId: pending.attemptId });
    } else {
      clearPending(userId);
      setPurchaseState(idle);
    }

    const sync = () => {
      void findOrder(userId).then((orderId) => {
        if (!cancelled && orderId) setPurchaseState({ status: 'held', orderId });
      });
    };
    sync();
    // The manager's `reconnect` fires only for automatic reconnects, not for
    // the deliberate reconnect `useSocket` does when the identity changes.
    socket.io.on('reconnect', sync);

    // A restored attempt nobody has decided by now had its result missed and
    // did not produce an order: let the user try again.
    const expiry =
      pending &&
      setTimeout(
        () => {
          void findOrder(userId).then((orderId) => {
            if (cancelled) return;
            if (!orderId) clearPending(userId);
            setPurchaseState((current) =>
              current.status === 'queued' && current.attemptId === pending.attemptId
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
      socket.io.off('reconnect', sync);
      if (expiry) clearTimeout(expiry);
    };
  }, [userId, socket]);

  // Once the sale has ended or sold out, a restored attempt without an order
  // has failed, whether or not its result ever reached a page.
  const saleStatus = sale?.status;
  const saleAvailability = sale?.availability;
  useEffect(() => {
    const restored = restoredRef.current;
    const outcome = restoredOutcome(
      saleStatus
        ? { status: saleStatus, ...(saleAvailability ? { availability: saleAvailability } : {}) }
        : undefined,
    );
    if (!userId || !restored || !outcome) return;
    let cancelled = false;

    // Confirm with a fresh lookup first: the attempt may have won before the
    // sale sold out, and only the order says so.
    void findOrder(userId).then((orderId) => {
      if (cancelled) return;
      setPurchaseState((current) =>
        current.status === 'queued' && current.attemptId === restored
          ? orderId
            ? { status: 'held', orderId }
            : outcome
          : current,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [userId, saleStatus, saleAvailability]);

  const purchase = useCallback(async () => {
    restoredRef.current = undefined;
    // Start collecting: the socket handler appends to this while we wait.
    arrivedEarlyRef.current = [];
    setPurchaseState({ status: 'submitting' });

    const response = await submitPurchase(userId);

    // Stop collecting, and take what the socket delivered in the meantime.
    const arrivedEarly = arrivedEarlyRef.current ?? [];
    arrivedEarlyRef.current = undefined;
    attemptRef.current = response.status === 'queued' ? response.attemptId : undefined;
    setPurchaseState((current) => applyOwnResponse(current, response, arrivedEarly));
  }, [userId]);

  return { purchaseState, purchase };
}
