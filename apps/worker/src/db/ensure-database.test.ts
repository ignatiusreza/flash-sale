import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { ensureDatabase } from './ensure-database.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('ensureDatabase', () => {
  // A throwaway name, so this never touches the database the other tests use.
  const name = `flashsale_test_${randomUUID().slice(0, 8)}`;
  // `||`, not `??`: a skipped suite's body still runs, and an empty URL is set.
  const target = new URL(DATABASE_URL || 'postgres://localhost/unused');
  target.pathname = `/${name}`;

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)}`);
    await admin.end();
  });

  it('creates a missing database, then leaves it alone', async () => {
    expect(await ensureDatabase(target.toString())).toBe(true);
    expect(await ensureDatabase(target.toString())).toBe(false);
  });

  it('leaves an existing database alone', async () => {
    expect(await ensureDatabase(DATABASE_URL!)).toBe(false);
  });
});
