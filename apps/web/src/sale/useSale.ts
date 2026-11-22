import type { Availability, SaleStatus } from '@flash-sale/core';
import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { useSocketEvent } from '../realtime/useSocketEvent.js';
import { clockOffset } from './clock.js';

export interface SaleSnapshot {
  readonly status: SaleStatus;
  /** Absent outside the active window: an ended sale is not "plenty". */
  readonly availability?: Availability;
  readonly startAt: string;
  readonly endAt: string;
}

/**
 * Keeps the page in step with the sale.
 *
 * Status is fetched once up front and then pushed over the socket, rather than
 * polled: the server knows when it changes. The one thing the fetch is needed
 * for is `serverTime`, which anchors the countdown to the server's clock.
 */
export function useSale(socket: Socket): {
  sale: SaleSnapshot | undefined;
  offsetMs: number;
} {
  const [sale, setSale] = useState<SaleSnapshot | undefined>();
  const [offsetMs, setOffsetMs] = useState(0);

  // On arrival, and again on every connect: the offset drifts, and after a
  // disconnect the snapshot may be stale.
  useEffect(() => {
    let cancelled = false;

    const load = () => {
      const sentAt = Date.now();
      void fetch('/api/sale')
        .then((response) => (response.ok ? response.json() : undefined))
        .then((body) => {
          if (cancelled || !body) return;
          setSale(body as SaleSnapshot);
          // `serverTime` was read somewhere between sending and receiving:
          // take the midpoint, not the arrival, or the countdown runs a
          // one-way trip ahead.
          const midpoint = (sentAt + Date.now()) / 2;
          setOffsetMs(clockOffset((body as { serverTime: string }).serverTime, midpoint));
        })
        .catch(() => {
          /* the socket will supply status once it connects */
        });
    };
    load();
    socket.on('connect', load);

    return () => {
      cancelled = true;
      socket.off('connect', load);
    };
  }, [socket]);

  useSocketEvent<SaleSnapshot>(socket, 'sale:status', setSale);

  return { sale, offsetMs };
}
