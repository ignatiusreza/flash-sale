import pg from 'pg';

/** Postgres SQLSTATEs this cares about. */
const INVALID_CATALOG_NAME = '3D000';
const DUPLICATE_DATABASE = '42P04';

/**
 * Creates the database `url` names if it does not exist yet. Returns whether it
 * had to.
 *
 * For development against a Postgres already on the host, which has the server
 * but not this project's database. Production provisions its database rather
 * than having the app create one, so nothing but the dev script calls this.
 *
 * It connects to the target first and falls back to the `postgres` maintenance
 * database only when the target is missing, so an existing database never needs
 * rights beyond connecting to it.
 */
export async function ensureDatabase(url: string): Promise<boolean> {
  try {
    await withClient(url, async () => {});
    return false;
  } catch (error) {
    if ((error as { code?: string }).code !== INVALID_CATALOG_NAME) throw error;
  }

  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';

  try {
    await withClient(maintenance.toString(), (client) =>
      client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`),
    );
    return true;
  } catch (error) {
    // Lost a race with another process creating it: the outcome is the same.
    if ((error as { code?: string }).code === DUPLICATE_DATABASE) return false;
    throw error;
  }
}

async function withClient<T>(url: string, use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}
