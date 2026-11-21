import type { PurchaseResultEvent, SaleStatus, Availability } from '@flash-sale/core';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { clockOffset } from './clock.js';

export interface SaleSnapshot {
  readonly status: SaleStatus;
  /** Absent outside the active window: an ended sale is not "plenty". */
  readonly availability?: Availability;
  readonly startAt: string;
  readonly endAt: string;
}

export interface SaleFeed {
  readonly sale: SaleSnapshot | undefined;
  readonly offsetMs: number;
  readonly viewers: number;
  readonly connected: boolean;
  /** Increments whenever a result for this user arrives. */
  readonly lastResult: PurchaseResultEvent | undefined;
}

/**
 * Keeps the page in step with the sale.
 *
 * Status is fetched once up front and then pushed over the socket, rather than
 * polled: the server knows when it changes. The one thing the fetch is needed
 * for is `serverTime`, which anchors the countdown to the server's clock.
 */
export function useSale(userId: string | undefined): SaleFeed {
  const [sale, setSale] = useState<SaleSnapshot | undefined>();
  const [offsetMs, setOffsetMs] = useState(0);
  const [viewers, setViewers] = useState(0);
  const [connected, setConnected] = useState(false);
  const [lastResult, setLastResult] = useState<PurchaseResultEvent | undefined>();
  const socketRef = useRef<Socket | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    void fetch('/api/sale')
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body) => {
        if (cancelled || !body) return;
        setSale(body as SaleSnapshot);
        setOffsetMs(clockOffset((body as { serverTime: string }).serverTime));
      })
      .catch(() => {
        /* the socket will supply status once it connects */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!userId) return;

    const socket = io({ auth: { userId }, transports: ['websocket'], autoConnect: false });
    socketRef.current = socket;

    // Connect a tick later: StrictMode mounts, unmounts and remounts in one
    // synchronous pass, so the throwaway mount is cleaned up before it ever
    // opens a connection instead of dropping one mid-handshake.
    const connectTimer = setTimeout(() => socket.connect(), 0);

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('sale:status', (payload: SaleSnapshot) => setSale(payload));
    socket.on('sale:viewers', (payload: { count: number }) => setViewers(payload.count));
    socket.on('purchase:result', (payload: PurchaseResultEvent) => setLastResult(payload));

    return () => {
      clearTimeout(connectTimer);
      socket.close();
      socketRef.current = undefined;
    };
  }, [userId]);

  return { sale, offsetMs, viewers, connected, lastResult };
}
