import type { PurchaseResultEvent } from '@flash-sale/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { findOrder, submitPurchase } from './api.js';
import { applyResult, idle, type PurchaseState } from './purchase-state.js';

/**
 * Where this user's purchasing stands, and the action that starts it.
 *
 * The state has three sources that must agree: the response to our own
 * attempt, results pushed over the socket, and an order found on arrival.
 */
export function usePurchase(
  userId: string,
  lastResult: PurchaseResultEvent | undefined,
): { purchaseState: PurchaseState; purchase: () => Promise<void> } {
  const [purchaseState, setPurchaseState] = useState<PurchaseState>(idle);
  // A ref, not state: it only decides how results are read, never what renders.
  const attemptRef = useRef<string | undefined>(undefined);

  // The socket may report an order this tab never asked for — another tab, or
  // an earlier visit. Folding it in is what keeps tabs agreeing.
  useEffect(() => {
    if (!lastResult) return;
    setPurchaseState((current) => applyResult(current, lastResult, attemptRef.current));
  }, [lastResult]);

  // On arrival, ask whether this user already holds an order. This is the
  // reconnect source of truth: without it a returning visitor sees a Buy
  // button for something they already own.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    void findOrder(userId).then((orderId) => {
      if (!cancelled && orderId) setPurchaseState({ status: 'held', orderId });
    });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const purchase = useCallback(async () => {
    setPurchaseState({ status: 'submitting' });
    const next = await submitPurchase(userId);
    attemptRef.current = next.status === 'queued' ? next.attemptId : undefined;
    setPurchaseState(next);
  }, [userId]);

  return { purchaseState, purchase };
}
