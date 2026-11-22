import type { Queryable } from '../db/pool.js';

export interface Grant {
  readonly userId: string;
  readonly orderId: string;
}

export interface ClaimResult {
  /** Users who now hold an order, in the arrival order they were offered in. */
  readonly granted: readonly Grant[];
  /** Stock left after this claim. */
  readonly remaining: number;
  /** False when the sale window is closed; then nothing is ever granted. */
  readonly open: boolean;
  /** The window, so callers can tell *not started* from *ended*. ISO 8601, UTC. */
  readonly startAt: string;
  readonly endAt: string;
}

/**
 * Claims up to `userIds.length` units in one statement, in arrival order.
 *
 * Three properties carry the design, each verified in `claim.test.ts`:
 *
 * 1. **Stock is decremented by rows actually inserted, never by batch size.**
 *    This is what makes a redelivered batch a no-op: on replay every user
 *    already holds an order, `ins` returns nothing, and the decrement is zero.
 *    The obvious `remaining - array_length($2, 1)` passes every other test and
 *    silently destroys stock on every redelivery — and RabbitMQ delivery is
 *    at-least-once, so that is not hypothetical.
 *
 * 2. **Places go to buyers who can win, in arrival order.** Each buyer is
 *    ranked once, at their first entry, and only if they hold no order yet:
 *    otherwise a holder or a repeat takes a place but no stock, and a buyer
 *    behind them is told sold out while units remain. The holder check is one
 *    unique-index probe per buyer: `LIMIT 1` keeps the planner from turning it
 *    into an anti-join over every order in the sale, which it does on
 *    statistics taken before the sale filled. When a batch straddles
 *    sellout the earliest arrivals win, which is where the brief's fairness
 *    requirement actually lives.
 *
 * 3. **`FOR UPDATE` is defence in depth.** With one active consumer there is
 *    no concurrency to guard against, but the statement stays correct if a
 *    second worker is ever running — during a botched failover, say. The
 *    final UPDATE joins `locked` so the lock is always taken first: read only
 *    from RETURNING, it ran after the row was updated, and found nothing,
 *    whenever no buyer in the batch was eligible.
 *
 * The window is checked here as well as at the API edge: this is the durable
 * enforcer, and the API's copy is only an optimisation (docs/PLAN.md §6).
 */
const CLAIM_SQL = `
WITH input AS (
  SELECT user_id, ord
  FROM unnest($2::text[]) WITH ORDINALITY AS t(user_id, ord)
),
locked AS (
  SELECT remaining, start_at, end_at, (now() >= start_at AND now() < end_at) AS open
  FROM sales WHERE id = $1
  FOR UPDATE
),
eligible AS (
  SELECT f.user_id, row_number() OVER (ORDER BY f.first_ord) AS place
  FROM (SELECT user_id, min(ord) AS first_ord FROM input GROUP BY user_id) f
  LEFT JOIN LATERAL (
    SELECT 1 AS held FROM orders WHERE sale_id = $1 AND user_id = f.user_id LIMIT 1
  ) o ON true
  WHERE o.held IS NULL
),
candidate AS (
  SELECT e.user_id
  FROM eligible e, locked l
  WHERE l.open AND e.place <= l.remaining
),
ins AS (
  INSERT INTO orders (sale_id, user_id)
  SELECT $1, user_id FROM candidate
  ON CONFLICT (sale_id, user_id) DO NOTHING
  RETURNING id, user_id
)
UPDATE sales s
SET remaining = s.remaining - (SELECT count(*) FROM ins)
FROM locked l
WHERE s.id = $1
RETURNING
  s.remaining,
  l.open,
  l.start_at,
  l.end_at,
  COALESCE(
    (SELECT json_agg(json_build_object('orderId', id, 'userId', user_id)) FROM ins),
    '[]'::json
  ) AS granted
`;

interface ClaimRow {
  remaining: number;
  open: boolean;
  start_at: Date;
  end_at: Date;
  granted: Grant[];
}

export async function claimBatch(
  db: Queryable,
  saleId: string,
  userIds: readonly string[],
): Promise<ClaimResult> {
  if (userIds.length === 0) {
    throw new Error('claimBatch called with an empty batch');
  }

  const result = await db.query<ClaimRow>(CLAIM_SQL, [saleId, [...userIds]]);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`no such sale: ${saleId}`);
  }

  return {
    granted: row.granted,
    remaining: row.remaining,
    open: row.open,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
  };
}

/**
 * Orders these users already hold. Used to tell "you already have one" — a
 * success — apart from "sold out", which the claim alone cannot distinguish
 * because `ON CONFLICT DO NOTHING` grants nothing in both cases.
 *
 * One query per batch, not per attempt.
 */
export async function findExistingOrders(
  db: Queryable,
  saleId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const { rows } = await db.query<{ user_id: string; id: string }>(
    'SELECT user_id, id FROM orders WHERE sale_id = $1 AND user_id = ANY($2::text[])',
    [saleId, [...userIds]],
  );
  return new Map(rows.map((r) => [r.user_id, r.id]));
}

/** A single claim is the batch with one element; there is no second statement to keep in step. */
export async function claimOne(
  db: Queryable,
  saleId: string,
  userId: string,
): Promise<ClaimResult> {
  return claimBatch(db, saleId, [userId]);
}
