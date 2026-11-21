import { availabilityOf, saleStatusAt, type SaleStatus, type Availability } from '@flash-sale/core';
import type pg from 'pg';

export interface SaleSnapshot {
  readonly saleId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly totalStock: number;
  readonly remaining: number;
}

export interface SaleView {
  readonly status: SaleStatus;
  /**
   * Present only while the sale is active.
   *
   * Stock and the window are independent facts, so an ended sale with units
   * left is genuinely "plenty" — and reporting that invites a client to show
   * "plenty available" on a sale nobody can buy from. The claim already
   * resolves the two in order, answering `ended` rather than `sold_out` when
   * the window is closed (see the worker's handler); this keeps the status
   * endpoint consistent with that by not answering a question that cannot be
   * acted on.
   */
  readonly availability?: Availability;
  readonly startAt: string;
  readonly endAt: string;
}

/**
 * Keeps the sale row in memory, refreshed on a timer.
 *
 * `GET /api/sale` is by far the highest-volume endpoint — every open tab polls
 * it — so it must cost no I/O per request (docs/PLAN.md §6, §7). Status is not
 * a correctness-critical read: being a second stale is harmless, because the
 * claim itself re-checks stock and the window durably.
 *
 * `remaining` is a denormalized column precisely so this refresh is a single
 * primary-key read rather than a count over a growing table.
 */
export class SaleCache {
  #snapshot: SaleSnapshot | undefined;
  #timer: NodeJS.Timeout | undefined;
  #lastError: unknown;

  constructor(
    private readonly pool: pg.Pool,
    private readonly saleId: string,
    private readonly refreshMs: number,
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.#timer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
    // Never hold the process open for a cache refresh.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async refresh(): Promise<void> {
    try {
      const { rows } = await this.pool.query<{
        start_at: Date;
        end_at: Date;
        total_stock: number;
        remaining: number;
      }>('SELECT start_at, end_at, total_stock, remaining FROM sales WHERE id = $1', [this.saleId]);

      const row = rows[0];
      this.#snapshot = row && {
        saleId: this.saleId,
        startAt: row.start_at.toISOString(),
        endAt: row.end_at.toISOString(),
        totalStock: row.total_stock,
        remaining: row.remaining,
      };
      this.#lastError = undefined;
    } catch (error) {
      // Keep serving the previous snapshot: a database blip should degrade the
      // freshness of a status endpoint, not take it down.
      this.#lastError = error;
    }
  }

  get snapshot(): SaleSnapshot | undefined {
    return this.#snapshot;
  }

  get healthy(): boolean {
    return this.#snapshot !== undefined && this.#lastError === undefined;
  }

  /** The public shape, with no exact stock count (§2.2). */
  view(now = new Date()): SaleView | undefined {
    const snapshot = this.#snapshot;
    if (!snapshot) return undefined;

    const status = saleStatusAt(snapshot, now);
    return {
      status,
      ...(status === 'active'
        ? { availability: availabilityOf(snapshot.remaining, snapshot.totalStock) }
        : {}),
      startAt: snapshot.startAt,
      endAt: snapshot.endAt,
    };
  }
}
