import type { SaleCache } from './cache.js';

export type Admission =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: 'not_started' | 'ended' | 'sold_out' };

/**
 * Decides whether an attempt is worth queueing at all (docs/PLAN.md §6).
 *
 * Most flash-sale traffic is doomed, and the cheapest request is the one never
 * published. Both checks read in-process state, so a rejection costs no I/O:
 *
 * 1. **Window** — `startAt`/`endAt` are config, so the entire pre-sale rush and
 *    everything after the close is rejected for free.
 * 2. **Sold out** — from the cached `remaining`, refreshed on a timer.
 *
 * Both are optimisations, never the authority: the claim re-checks stock and
 * the window durably, so a stale cache can only ever cost a wasted enqueue.
 * It must not be able to wrongly *reject*, which is why a missing snapshot
 * admits rather than refuses — see `admit` below.
 */
export function admit(cache: SaleCache, now = new Date()): Admission {
  const view = cache.view(now);

  // No snapshot yet: let it through and let the worker decide. Failing open is
  // right here because being wrong costs one queued message, whereas failing
  // closed would reject real buyers during a database blip.
  if (!view) return { admit: true };

  if (view.status === 'upcoming') return { admit: false, reason: 'not_started' };
  if (view.status === 'ended') return { admit: false, reason: 'ended' };
  if (view.availability === 'sold_out') return { admit: false, reason: 'sold_out' };
  return { admit: true };
}
