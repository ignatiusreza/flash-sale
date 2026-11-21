import type pg from 'pg';

export interface ExistingOrder {
  readonly orderId: string;
  readonly purchasedAt: string;
}

/**
 * The reconnect source of truth (docs/PLAN.md §5, §7). A dropped socket is
 * only cosmetic because this exists: the client re-syncs here and lands on the
 * right terminal state regardless of what it missed.
 */
export async function findOrder(
  pool: pg.Pool,
  saleId: string,
  userId: string,
): Promise<ExistingOrder | undefined> {
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    'SELECT id, created_at FROM orders WHERE sale_id = $1 AND user_id = $2',
    [saleId, userId],
  );
  const row = rows[0];
  return row && { orderId: row.id, purchasedAt: row.created_at.toISOString() };
}
