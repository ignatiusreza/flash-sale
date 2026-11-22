import { useCallback, useState } from 'react';

const KEY = 'flash-sale:userId';

/** Reads through a try/catch: private windows and blocked storage both throw. */
function readStored(): string {
  try {
    return window.localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Remembers who the visitor said they are.
 *
 * Persisted so a refresh does not lose your identity mid-sale — which would
 * otherwise look like losing your order, since the order is keyed on it.
 * There is no authentication in this exercise (docs/PLAN.md §2.2); this is a
 * name the visitor chooses, not a claim about who they are.
 */
export function useIdentity(): {
  userId: string;
  setUserId: (value: string) => void;
} {
  const [userId, setStateUserId] = useState(readStored);

  const setUserId = useCallback((value: string) => {
    setStateUserId(value);
    try {
      if (value) window.localStorage.setItem(KEY, value);
      else window.localStorage.removeItem(KEY);
    } catch {
      // Storage being unavailable is not a reason to stop working.
    }
  }, []);

  return { userId, setUserId };
}
