import type { Queryable } from './db.js';

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
 * 2. **`ord <= remaining` preserves arrival order.** When a batch straddles
 *    sellout the earliest arrivals win, which is where the brief's fairness
 *    requirement actually lives.
 *
 * 3. **`FOR UPDATE` is defence in depth.** With one active consumer there is
 *    no concurrency to guard against, but the statement stays correct if a
 *    second worker is ever running — during a botched failover, say.
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
  SELECT remaining, (now() >= start_at AND now() < end_at) AS open
  FROM sales WHERE id = $1
  FOR UPDATE
),
candidate AS (
  SELECT i.user_id
  FROM input i, locked l
  WHERE l.open AND i.ord <= l.remaining
),
ins AS (
  INSERT INTO orders (sale_id, user_id)
  SELECT $1, user_id FROM candidate
  ON CONFLICT (sale_id, user_id) DO NOTHING
  RETURNING id, user_id
)
UPDATE sales
SET remaining = remaining - (SELECT count(*) FROM ins)
WHERE id = $1
RETURNING
  remaining,
  (SELECT open FROM locked) AS open,
  COALESCE(
    (SELECT json_agg(json_build_object('orderId', id, 'userId', user_id)) FROM ins),
    '[]'::json
  ) AS granted
`;

interface ClaimRow {
  remaining: number;
  open: boolean;
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

  return { granted: row.granted, remaining: row.remaining, open: row.open };
}

/** A single claim is the batch with one element; there is no second statement to keep in step. */
export async function claimOne(
  db: Queryable,
  saleId: string,
  userId: string,
): Promise<ClaimResult> {
  return claimBatch(db, saleId, [userId]);
}
