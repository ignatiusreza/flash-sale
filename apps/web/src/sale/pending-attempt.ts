import type { PendingAttempt } from './purchase-state.js';

/**
 * The attempt each user has in flight, in localStorage so it survives a
 * refresh and every tab sees it — results already go to all of a user's tabs.
 *
 * Every access is guarded: private windows and blocked storage throw, and an
 * unreadable entry is no reason to stop working.
 */
const keyFor = (userId: string) => `flash-sale:pending:${userId}`;

export function loadPending(userId: string): PendingAttempt | undefined {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PendingAttempt>;
    return typeof value.attemptId === 'string' && typeof value.since === 'number'
      ? { attemptId: value.attemptId, since: value.since }
      : undefined;
  } catch {
    return undefined;
  }
}

export function savePending(userId: string, pending: PendingAttempt): void {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(pending));
  } catch {
    /* the page still works; a refresh just forgets the attempt */
  }
}

export function clearPending(userId: string): void {
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    /* nothing to clear */
  }
}
