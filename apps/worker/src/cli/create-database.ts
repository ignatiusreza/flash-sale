import { ensureDatabase } from '../db/ensure-database.js';

/**
 * Creates the database DATABASE_URL names, if missing, and exits. Run by
 * `pnpm dev` before migrating, so a Postgres already on the host works without
 * any setup.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const name = new URL(url).pathname.slice(1);
console.warn((await ensureDatabase(url)) ? `created database ${name}` : `database ${name} exists`);
