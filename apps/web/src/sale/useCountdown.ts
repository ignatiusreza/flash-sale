import { useEffect, useState } from 'react';

import { remainingMs } from './clock.js';

/** Milliseconds left until `target`, ticking once a second against the server clock. */
export function useCountdown(target: string | undefined, offsetMs: number): number {
  // Only the clock is state; the countdown is derived from it in render, so a
  // changed target shows its own value at once rather than the previous one's.
  // The tick can be up to a second old, which only ever reads high, never early.
  const [now, setNow] = useState(() => Date.now());

  // Always ticking: started only with a target, a target appearing after a
  // long gap would read off a clock minutes old until the first tick.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return target ? remainingMs(target, offsetMs, now) : 0;
}
