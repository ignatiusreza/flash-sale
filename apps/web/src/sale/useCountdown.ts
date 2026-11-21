import { useEffect, useState } from 'react';

import { remainingMs } from './clock.js';

/** Milliseconds left until `target`, ticking once a second against the server clock. */
export function useCountdown(target: string | undefined, offsetMs: number): number {
  const [left, setLeft] = useState(() => (target ? remainingMs(target, offsetMs) : 0));

  useEffect(() => {
    if (!target) return;

    // Set immediately as well as on the interval, so a changed target does not
    // show the previous one's value for up to a second.
    setLeft(remainingMs(target, offsetMs));
    const timer = setInterval(() => setLeft(remainingMs(target, offsetMs)), 1000);
    return () => clearInterval(timer);
  }, [target, offsetMs]);

  return left;
}
