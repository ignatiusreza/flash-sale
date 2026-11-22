import { applyResponse, type PurchaseState } from './purchase-state.js';

/**
 * The order this user already holds, if any. Failures read as "none": the
 * socket will report an order if one turns up, so a failed lookup costs nothing
 * worse than a Buy button the server will answer with `already_purchased`.
 */
export async function findOrder(userId: string): Promise<string | undefined> {
  try {
    const response = await fetch(`/api/purchase/${encodeURIComponent(userId)}`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { status?: string; orderId?: string };
    return body.status === 'confirmed' ? body.orderId : undefined;
  } catch {
    return undefined;
  }
}

/** Submits an attempt and maps the immediate response; the outcome arrives over the socket. */
export async function submitPurchase(userId: string): Promise<PurchaseState> {
  try {
    const response = await fetch('/api/purchase', {
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
