import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

/**
 * Applies migrations and exits.
 *
 * The worker also migrates on boot, but the API reads `sales` as soon as it
 * starts, so something has to go first. Running this before either removes the
 * race rather than relying on the API's cache tolerating an empty schema.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const pool = createPool(url);
try {
  await migrate(pool, (message) => console.warn(message));
  console.warn('migrations up to date');
} finally {
  await pool.end();
}
