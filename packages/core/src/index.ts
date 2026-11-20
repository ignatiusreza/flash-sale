/**
 * Shared contracts between the API, the worker and the web client.
 *
 * Every instant crossing a boundary is an ISO 8601 string in UTC with an
 * explicit `Z` — see docs/PLAN.md §9.1. Nothing here formats a local time.
 */

export type SaleStatus = 'upcoming' | 'active' | 'ended';

export type Availability = 'plenty' | 'low' | 'sold_out';

/** Outcome of a purchase attempt, as reported to the client. */
export type PurchaseOutcome =
  'confirmed' | 'already_purchased' | 'sold_out' | 'not_started' | 'ended';

export interface SaleWindow {
  /** ISO 8601, UTC. */
  readonly startAt: string;
  /** ISO 8601, UTC. */
  readonly endAt: string;
}

export interface SaleState extends SaleWindow {
  readonly status: SaleStatus;
  readonly availability: Availability;
  /** ISO 8601, UTC — lets the client run a countdown without trusting its own clock. */
  readonly serverTime: string;
  readonly viewers: number;
}

export interface PurchaseResult {
  readonly attemptId: string;
  readonly userId: string;
  readonly status: PurchaseOutcome;
  readonly orderId?: string;
}

/**
 * Derive sale status from a window. The window is half-open — `endAt` itself
 * is already ended — which matches the claim predicate in docs/PLAN.md §4.
 */
export function saleStatusAt(window: SaleWindow, now: Date): SaleStatus {
  const t = now.getTime();
  if (t < Date.parse(window.startAt)) return 'upcoming';
  if (t >= Date.parse(window.endAt)) return 'ended';
  return 'active';
}

/**
 * Coarse availability. Exact remaining stock is deliberately not exposed: it
 * invites polling and leaks sale mechanics (docs/PLAN.md §2.2).
 */
export function availabilityOf(remaining: number, total: number): Availability {
  if (remaining <= 0) return 'sold_out';
  if (total > 0 && remaining / total <= 0.1) return 'low';
  return 'plenty';
}
