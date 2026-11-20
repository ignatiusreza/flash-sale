import { createPool } from './db.js';
import { migrate } from './migrate.js';

export { claimBatch, claimOne, type ClaimResult, type Grant } from './claim.js';
export { createPool, type Queryable } from './db.js';
export { migrate } from './migrate.js';

/**
 * Phase 0–1 entrypoint: applies migrations and exits. The consumer loop that
 * drives `claimBatch` arrives in phase 2, once there is a queue to read from
 * (docs/PLAN.md §13).
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const pool = createPool(url);
  try {
    await migrate(pool, (message) => console.warn(message));
    console.warn('migrations up to date');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
