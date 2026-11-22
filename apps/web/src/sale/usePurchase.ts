import type { Availability, PurchaseResultEvent, SaleStatus } from '@flash-sale/core';
import { useCallback, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { useSocketEvent } from '../realtime/useSocketEvent.js';
import { submitPurchase } from './api.js';
import {
  applyOwnResponse,
  applyResult,
  attemptOf,
  idle,
  type PurchaseState,
} from './purchase-state.js';
import { useOrderSync } from './useOrderSync.js';
import { usePendingAttempt } from './usePendingAttempt.js';

type Sale = { readonly status: SaleStatus; readonly availability?: Availability } | undefined;

/**
 * Where this user's purchasing stands, and the action that starts it.
 *
 * The state has four sources that must agree: the response to our own
 * attempt, results pushed over the socket, an order found by lookup
 * (`useOrderSync`), and an attempt left pending by an earlier page
 * (`usePendingAttempt`).
 */
export function usePurchase(
  userId: string,
  socket: Socket,
  sale: Sale,
): { purchaseState: PurchaseState; purchase: () => Promise<void> } {
  const [purchaseState, setPurchaseState] = useState<PurchaseState>(idle);
  // Results that arrive while our POST is in flight, before its 202 tells us
  // which attempt is ours (see `applyOwnResponse`). Undefined when idle.
  const arrivedEarlyRef = useRef<PurchaseResultEvent[] | undefined>(undefined);

  // The socket may report an order this tab never asked for — another tab, or
  // an earlier visit. Folding it in is what keeps tabs agreeing.
  useSocketEvent<PurchaseResultEvent>(socket, 'purchase:result', (result) => {
    // Only while `purchase()` is waiting on its POST; it reads these back.
    arrivedEarlyRef.current?.push(result);
    setPurchaseState((current) => applyResult(current, result, attemptOf(current)));
  });

  useOrderSync(userId, socket, (orderId) => setPurchaseState({ status: 'held', orderId }));
  usePendingAttempt(userId, purchaseState, sale, setPurchaseState);

  const purchase = useCallback(async () => {
    // Start collecting: the socket handler appends to this while we wait.
    arrivedEarlyRef.current = [];
    setPurchaseState({ status: 'submitting' });

    const response = await submitPurchase(userId);

    // Stop collecting, and take what the socket delivered in the meantime.
    const arrivedEarly = arrivedEarlyRef.current ?? [];
    arrivedEarlyRef.current = undefined;
    setPurchaseState((current) => applyOwnResponse(current, response, arrivedEarly));
  }, [userId]);

  return { purchaseState, purchase };
}
