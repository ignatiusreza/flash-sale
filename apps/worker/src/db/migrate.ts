import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

// Resolved from this file's compiled location: `dist/db/` is two levels below
// the package root, where `migrations/` sits beside `dist/`.
const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

/** Arbitrary but fixed: two workers starting together must not both migrate. */
const ADVISORY_LOCK_KEY = 8_164_201;

/**
 * Applies pending migrations in filename order, each in its own transaction.
 *
 * Deliberately hand-rolled rather than pulling in a framework: there are two
 * tables, the whole thing is reviewable in one screen, and a migration tool
 * would be more configuration than the problem deserves.
 */
export async function migrate(pool: pg.Pool, log: (message: string) => void = () => {}) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      const applied = new Set(
        (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
          (r) => r.version,
        ),
      );

      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
          log(`applied ${file}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${file} failed: ${(error as Error).message}`, {
            cause: error,
          });
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
