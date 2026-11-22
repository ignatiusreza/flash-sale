import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

import { findOrder } from './api.js';

/**
 * Asks whether this user holds an order and reports it: on arrival, so a
 * returning visitor is not offered a Buy button for something they own, and
 * after every reconnect, because a result pushed while the socket was down is
 * gone for good while the order it announced is not (docs/PLAN.md §5).
 */
export function useOrderSync(
  userId: string,
  socket: Socket,
  onOrder: (orderId: string) => void,
): void {
  // The latest callback, read when the lookup answers.
  const onOrderRef = useRef(onOrder);
  useEffect(() => {
    onOrderRef.current = onOrder;
  });

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const sync = () => {
      void findOrder(userId).then((orderId) => {
        if (!cancelled && orderId) onOrderRef.current(orderId);
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
}
