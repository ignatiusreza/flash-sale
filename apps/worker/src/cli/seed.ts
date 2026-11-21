import { createPool } from '../db/pool.js';

/**
 * Ensures a sale exists, for development.
 *
 * Migrations create the schema but no rows, so a fresh environment serves
 * `sale_unavailable` and reports itself not ready until someone inserts one.
 * A startup script that leaves the app dead is not much of a startup script.
 *
 * Idempotent: an existing sale is left exactly as it is, so restarting the dev
 * stack never resets stock out from under whatever you were testing. Use
 * `SEED_RESET=1` to deliberately start over.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const saleId = process.env.SALE_ID ?? 'flash';
const stock = Number(process.env.SEED_STOCK ?? 100);
const durationMinutes = Number(process.env.SEED_DURATION_MINUTES ?? 60);
const reset = process.env.SEED_RESET === '1';

const pool = createPool(url);
try {
  if (reset) {
    await pool.query('DELETE FROM orders WHERE sale_id = $1', [saleId]);
    await pool.query('DELETE FROM sales WHERE id = $1', [saleId]);
  }

  const { rowCount } = await pool.query(
    `INSERT INTO sales (id, total_stock, remaining, start_at, end_at)
     VALUES ($1, $2, $2, now(), now() + ($3 || ' minutes')::interval)
     ON CONFLICT (id) DO NOTHING`,
    [saleId, stock, durationMinutes],
  );

  if (rowCount === 0) {
    const { rows } = await pool.query<{ remaining: number; total_stock: number }>(
      'SELECT remaining, total_stock FROM sales WHERE id = $1',
      [saleId],
    );
    const sale = rows[0];
    console.warn(`sale "${saleId}" already exists (${sale?.remaining}/${sale?.total_stock} left)`);
  } else {
    console.warn(`seeded sale "${saleId}" with ${stock} units for ${durationMinutes} minutes`);
  }
} finally {
  await pool.end();
}
