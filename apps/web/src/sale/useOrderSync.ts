import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

import { findOrder } from './api.js';

/**
 * Asks whether this user holds an order and reports it, each time the socket
 * connects: on arrival, so a returning visitor is not offered a Buy button for
 * something they own, and after every reconnect, because a result pushed while
 * the socket was down is gone for good while the order it announced is not
 * (docs/PLAN.md §5).
 *
 * On `connect`, not the manager's `reconnect`: that one fires only for
 * automatic reconnects, so a result decided before the first connection, or
 * the one `useSocket` makes after a name change, was never looked up.
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
    if (socket.connected) sync();
    socket.on('connect', sync);

    return () => {
      cancelled = true;
      socket.off('connect', sync);
    };
  }, [userId, socket]);
}
