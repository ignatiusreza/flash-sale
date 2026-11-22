import { useState } from 'react';
import type { Socket } from 'socket.io-client';

import { useSocketEvent } from '../realtime/useSocketEvent.js';

/** How many people are looking, as pushed by the server (docs/PLAN.md §8). */
export function useViewers(socket: Socket): number {
  const [viewers, setViewers] = useState(0);
  useSocketEvent<{ count: number }>(socket, 'sale:viewers', (payload) => setViewers(payload.count));
  return viewers;
}
