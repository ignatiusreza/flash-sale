import type { SaleCache } from './cache.js';

export type Admission =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: 'not_started' | 'ended' | 'sold_out' };

/**
 * Near a window edge the cache is not good enough to refuse on: it is up to a
 * refresh old, and this host's clock is not the database's `now()` the claim
 * judges by — NTP keeps them within milliseconds, not to the instant. So
 * attempts this close are left to the claim.
 */
export const EDGE_GRACE_MS = 1_000;

/**
 * Decides whether an attempt is worth queueing at all (docs/PLAN.md §6).
 *
 * Most flash-sale traffic is doomed, and the cheapest request is the one never
 * published. Both checks read in-process state, so a rejection costs no I/O:
 *
 * 1. **Window** — from the cached sale, so the pre-sale rush and everything
 *    after the close is rejected for free.
 * 2. **Sold out** — from the cached `remaining`, refreshed on a timer.
 *
 * Both are optimisations, never the authority: the claim re-checks stock and
 * the window durably, so a stale cache can only ever cost a wasted enqueue.
 * It must not be able to wrongly *reject*, which is why a missing snapshot
 * admits rather than refuses, and an attempt within `EDGE_GRACE_MS` of
 * either edge is admitted for the claim to judge.
 */
export function admit(cache: SaleCache, now = new Date()): Admission {
  const view = cache.view(now);

  // No snapshot yet: let it through and let the worker decide. Failing open is
  // right here because being wrong costs one queued message, whereas failing
  // closed would reject real buyers during a database blip.
  if (!view) return { admit: true };

  const nearEdge = [view.startAt, view.endAt].some(
    (edge) => Math.abs(now.getTime() - Date.parse(edge)) < EDGE_GRACE_MS,
  );
  if (nearEdge) return { admit: true };

  if (view.status === 'upcoming') return { admit: false, reason: 'not_started' };
  if (view.status === 'ended') return { admit: false, reason: 'ended' };
  if (view.availability === 'sold_out') return { admit: false, reason: 'sold_out' };
  return { admit: true };
}
