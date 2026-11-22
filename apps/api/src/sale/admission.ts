import type { SaleCache } from './cache.js';

export type Admission =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: 'not_started' | 'ended' | 'sold_out' };

/**
 * How long before the open, and after the close, the cache admits rather than
 * refuses. Those are the only places a refusal could be wrong: this host
 * thinks the sale not yet open, or over, while the database's `now()` — the
 * claim's clock — already, or still, has it open. NTP keeps the two within
 * milliseconds; the window's times do not change between refreshes, so the
 * cache's staleness does not widen it. Just enough to cover skew, so the
 * pre-sale rush is still refused for free up to its last instant (issue #17).
 */
export const EDGE_GRACE_MS = 100;

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
 * admits rather than refuses, and the moments either side of the window —
 * `EDGE_GRACE_MS` — are left to the claim.
 */
export function admit(cache: SaleCache, now = new Date()): Admission {
  const view = cache.view(now);

  // No snapshot yet: let it through and let the worker decide. Failing open is
  // right here because being wrong costs one queued message, whereas failing
  // closed would reject real buyers during a database blip.
  if (!view) return { admit: true };

  const time = now.getTime();
  if (view.status === 'upcoming') {
    return time >= Date.parse(view.startAt) - EDGE_GRACE_MS
      ? { admit: true }
      : { admit: false, reason: 'not_started' };
  }

  // Before the close's grace: with nothing left, there is nothing to win
  // either side of it.
  if (view.availability === 'sold_out' || cache.snapshot?.remaining === 0) {
    return { admit: false, reason: 'sold_out' };
  }

  if (view.status === 'ended') {
    return time < Date.parse(view.endAt) + EDGE_GRACE_MS
      ? { admit: true }
      : { admit: false, reason: 'ended' };
  }
  return { admit: true };
}
