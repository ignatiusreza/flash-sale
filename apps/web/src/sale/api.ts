import { applyResponse, type PurchaseState } from './purchase-state.js';

/**
 * What a lookup of the user's order learned. `unknown` is not `none`: a lookup
 * that was rate limited, failed on the server or never arrived says nothing
 * about whether the user holds an order, so it must never settle anything.
 */
export type OrderLookup =
  | { readonly status: 'held'; readonly orderId: string }
  | { readonly status: 'none' }
  | { readonly status: 'unknown'; readonly retryAfterMs?: number };

export type KnownOrderLookup = Exclude<OrderLookup, { status: 'unknown' }>;

/** One lookup: `none` only from a successful answer listing no order. */
export async function lookupOrder(userId: string): Promise<OrderLookup> {
  try {
    const response = await fetch(`/api/orders?userId=${encodeURIComponent(userId)}`);
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      return retryAfter > 0
        ? { status: 'unknown', retryAfterMs: retryAfter * 1000 }
        : { status: 'unknown' };
    }
    const orders = (await response.json()) as { orderId: string }[];
    const orderId = orders[0]?.orderId;
    return orderId ? { status: 'held', orderId } : { status: 'none' };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * Looks the order up until the answer is known, retrying with backoff — and
 * at least as long as `Retry-After` asks. Reading a failed lookup as "none"
 * turned a winner whose result was lost into "Sold out" once the sale sold
 * out (issue #17). Resolves undefined if aborted first.
 */
export async function lookupOrderUntilKnown(
  userId: string,
  signal: AbortSignal,
  delays = { firstMs: 1_000, maxMs: 30_000 },
): Promise<KnownOrderLookup | undefined> {
  for (let delay = delays.firstMs; !signal.aborted; delay = Math.min(delay * 2, delays.maxMs)) {
    const result = await lookupOrder(userId);
    if (signal.aborted) return undefined;
    if (result.status !== 'unknown') return result;
    await pause(Math.max(delay, result.retryAfterMs ?? 0), signal);
  }
  return undefined;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Submits an attempt and maps the immediate response; the outcome arrives over the socket. */
export async function submitPurchase(userId: string): Promise<PurchaseState> {
  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const body: unknown = await response.json().catch(() => ({}));
    return applyResponse(response.status, body);
  } catch {
    return { status: 'failed', message: 'Could not reach the server.' };
  }
}
