import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Calls `handler` for every `event` on `socket`, for as long as the component
 * is mounted. Listeners survive reconnects, so this subscribes once per socket.
 */
export function useSocketEvent<T>(
  socket: Socket,
  event: string,
  handler: (payload: T) => void,
): void {
  // The latest handler, read when the event fires: a handler closing over
  // fresh state then needs no resubscription on every render.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const listener = (payload: T) => handlerRef.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event]);
}
