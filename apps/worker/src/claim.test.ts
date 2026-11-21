import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { claimBatch, claimOne } from './claim.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const DATABASE_URL = process.env.DATABASE_URL;

// Every test gets its own sale rather than sharing one and deleting between
// cases. Vitest runs files in parallel, so a shared row plus a DELETE makes two
// suites quietly destroy each other's fixtures — which looks exactly like a bug
// in the code under test (docs/PLAN.md §11).
let SALE: string;

// Skipped on a bare checkout so `pnpm test` stays green; runs in the compose
// `runner` service and in CI, which both provide a Postgres.
const describeDb = DATABASE_URL ? describe : describe.skip;

let pool: pg.Pool;

async function seed(options: { stock: number; startsIn?: number; endsIn?: number }): Promise<void> {
  const { stock, startsIn = -60_000, endsIn = 3_600_000 } = options;
  SALE = `claim-${randomUUID()}`;
  await pool.query(
    `INSERT INTO sales (id, total_stock, remaining, start_at, end_at)
     VALUES ($1, $2, $2, now() + ($3 || ' milliseconds')::interval, now() + ($4 || ' milliseconds')::interval)`,
    [SALE, stock, startsIn, endsIn],
  );
}

async function counts() {
  const { rows } = await pool.query<{ orders: string; remaining: number; users: string }>(
    `SELECT (SELECT count(*) FROM orders WHERE sale_id = $1)::text AS orders,
            (SELECT count(DISTINCT user_id) FROM orders WHERE sale_id = $1)::text AS users,
            (SELECT remaining FROM sales WHERE id = $1) AS remaining`,
    [SALE],
  );
  const row = rows[0]!;
  return { orders: Number(row.orders), users: Number(row.users), remaining: row.remaining };
}

describeDb('claim', () => {
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!, 30);
    await migrate(pool);
  });

  afterAll(async () => {
    // Per-test sales keep suites independent, but they also accumulate: the
    // dev stack shares this database, and without this every run leaves
    // another few dozen rows behind for good.
    await pool?.query("DELETE FROM orders WHERE sale_id LIKE 'claim-%'");
    await pool?.query("DELETE FROM sales WHERE id LIKE 'claim-%'");
    await pool?.end();
  });

  beforeEach(async () => {
    await seed({ stock: 10 });
  });

  it('grants a unit and decrements stock', async () => {
    const result = await claimOne(pool, SALE, 'alice');

    expect(result.granted).toHaveLength(1);
    expect(result.granted[0]!.userId).toBe('alice');
    expect(result.granted[0]!.orderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.remaining).toBe(9);
  });

  it('grants nothing on a repeat claim, and consumes no stock', async () => {
    await claimOne(pool, SALE, 'alice');
    const second = await claimOne(pool, SALE, 'alice');

    expect(second.granted).toEqual([]);
    expect(second.remaining).toBe(9);
    expect((await counts()).orders).toBe(1);
  });

  it('grants a partial batch when it straddles sellout, earliest first', async () => {
    await seed({ stock: 3 });
    const users = ['u1', 'u2', 'u3', 'u4', 'u5'];

    const result = await claimBatch(pool, SALE, users);

    expect(result.granted.map((g) => g.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(result.remaining).toBe(0);
  });

  it('charges one unit for a user repeated inside a single batch', async () => {
    const result = await claimBatch(pool, SALE, ['dupe', 'dupe', 'dupe']);

    expect(result.granted).toHaveLength(1);
    expect(result.remaining).toBe(9);
  });

  it('is idempotent when a committed batch is redelivered', async () => {
    const users = ['a', 'b', 'c'];
    const first = await claimBatch(pool, SALE, users);
    expect(first.granted).toHaveLength(3);

    const replay = await claimBatch(pool, SALE, users);

    expect(replay.granted).toEqual([]);
    expect(replay.remaining).toBe(7);
    expect(await counts()).toMatchObject({ orders: 3, remaining: 7 });
  });

  it('grants nothing before the window opens', async () => {
    await seed({ stock: 10, startsIn: 60_000 });

    const result = await claimBatch(pool, SALE, ['early']);

    expect(result.open).toBe(false);
    expect(result.granted).toEqual([]);
    expect(result.remaining).toBe(10);
  });

  it('grants nothing after the window closes', async () => {
    await seed({ stock: 10, startsIn: -120_000, endsIn: -60_000 });

    const result = await claimBatch(pool, SALE, ['late']);

    expect(result.open).toBe(false);
    expect(result.granted).toEqual([]);
    expect(result.remaining).toBe(10);
  });

  it('grants nothing once sold out', async () => {
    await seed({ stock: 1 });
    await claimOne(pool, SALE, 'winner');

    const result = await claimOne(pool, SALE, 'loser');

    expect(result.open).toBe(true);
    expect(result.granted).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  describe('the invariants', () => {
    it('never oversells, under 20x oversubscription', async () => {
      const stock = 1000;
      const attempts = 20_000;
      await seed({ stock });

      // 200 concurrent batches of 100 distinct users each.
      const batches: string[][] = [];
      for (let i = 0; i < attempts; i += 100) {
        batches.push(Array.from({ length: 100 }, (_, n) => `user-${i + n}`));
      }
      const results = await Promise.all(batches.map((b) => claimBatch(pool, SALE, b)));

      const grantedTotal = results.reduce((sum, r) => sum + r.granted.length, 0);
      const grantedUsers = new Set(results.flatMap((r) => r.granted.map((g) => g.userId)));

      // Both halves matter: a lost update can leave the table immaculate while
      // having told thousands of clients they won (docs/PLAN.md §11).
      expect(grantedTotal).toBe(stock);
      expect(grantedUsers.size).toBe(stock);
      expect(await counts()).toEqual({ orders: stock, users: stock, remaining: 0 });
    });

    it('never grants one user two units, under concurrent duplicate attempts', async () => {
      const stock = 1000;
      await seed({ stock });

      const results = await Promise.all(
        Array.from({ length: 500 }, () => claimOne(pool, SALE, 'same-user')),
      );

      const grantedTotal = results.reduce((sum, r) => sum + r.granted.length, 0);

      expect(grantedTotal).toBe(1);
      expect(await counts()).toEqual({ orders: 1, users: 1, remaining: stock - 1 });
    });
  });
});
