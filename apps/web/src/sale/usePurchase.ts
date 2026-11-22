import type { PurchaseResultEvent } from '@flash-sale/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { useSocketEvent } from '../realtime/useSocketEvent.js';
import { findOrder, submitPurchase } from './api.js';
import { applyOwnResponse, applyResult, idle, type PurchaseState } from './purchase-state.js';

/**
 * Where this user's purchasing stands, and the action that starts it.
 *
 * The state has three sources that must agree: the response to our own
 * attempt, results pushed over the socket, and an order found on arrival.
 */
export function usePurchase(
  userId: string,
  socket: Socket,
): { purchaseState: PurchaseState; purchase: () => Promise<void> } {
  const [purchaseState, setPurchaseState] = useState<PurchaseState>(idle);
  // Refs, not state: they decide how results are read, never what renders.
  const attemptRef = useRef<string | undefined>(undefined);
  // Results that arrive while our POST is in flight, before its 202 tells us
  // which attempt is ours (see `applyOwnResponse`). Undefined when idle.
  const arrivedEarlyRef = useRef<PurchaseResultEvent[] | undefined>(undefined);

  // The socket may report an order this tab never asked for — another tab, or
  // an earlier visit. Folding it in is what keeps tabs agreeing.
  useSocketEvent<PurchaseResultEvent>(socket, 'purchase:result', (result) => {
    // Only while `purchase()` is waiting on its POST; it reads these back.
    arrivedEarlyRef.current?.push(result);
    setPurchaseState((current) => applyResult(current, result, attemptRef.current));
  });

  // Ask whether this user already holds an order: on arrival, so a returning
  // visitor is not offered a Buy button for something they own, and after
  // every reconnect, because a result pushed while the socket was down is gone
  // for good while the order it announced is not (docs/PLAN.md §5).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const sync = () => {
      void findOrder(userId).then((orderId) => {
        if (!cancelled && orderId) setPurchaseState({ status: 'held', orderId });
      });
    };
    sync();
    // The manager's `reconnect` fires only for automatic reconnects, not for
    // the deliberate reconnect `useSocket` does when the identity changes.
    socket.io.on('reconnect', sync);

    return () => {
      cancelled = true;
      socket.io.off('reconnect', sync);
    };
  }, [userId, socket]);

  const purchase = useCallback(async () => {
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
