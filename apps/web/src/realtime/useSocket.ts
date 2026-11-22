import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

/**
 * The page's one Socket.IO connection, identified as `userId` once there is
 * one. Connected before that too, anonymously: a visitor still watching the
 * page, name not yet typed, sees the sale open, close or sell out live. A new
 * name reconnects, so the server routes that user's results here.
 *
 * The socket object exists from the first render, unconnected, so every
 * consumer can attach its listeners in its own effect before the connection
 * opens: the server greets a new connection with the sale status and viewer
 * count straight away, and an event that arrives before its listener is lost.
 */
export function useSocket(userId: string | undefined): { socket: Socket; connected: boolean } {
  const [socket] = useState(() => io({ autoConnect: false, transports: ['websocket'] }));
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const up = () => setConnected(true);
    const down = () => setConnected(false);
    socket.on('connect', up);
    socket.on('disconnect', down);
    return () => {
      socket.off('connect', up);
      socket.off('disconnect', down);
    };
  }, [socket]);

  useEffect(() => {
    socket.auth = userId ? { userId } : {};

    // Connect a tick later: StrictMode mounts, unmounts and remounts in one
    // synchronous pass, so the throwaway mount is cleaned up before it ever
    // opens a connection instead of dropping one mid-handshake.
    const connectTimer = setTimeout(() => socket.connect(), 0);

    return () => {
      clearTimeout(connectTimer);
      socket.disconnect();
    };
  }, [socket, userId]);

  return { socket, connected };
}
