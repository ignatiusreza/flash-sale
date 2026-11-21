import pg from 'pg';

/**
 * Connection pool. The session timezone is pinned to UTC on the connection
 * itself rather than relying on server config or the container's TZ, because
 * that is the one place the setting survives being pointed at someone else's
 * database (docs/PLAN.md §9.1).
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    options: '-c timezone=UTC',
    // Without this, an unreachable host does not fail — it hangs until the
    // kernel gives up on the TCP connect, which can be minutes. A process that
    // cannot reach its database should say so immediately, not look wedged.
    connectionTimeoutMillis: 5_000,
  });
}

export type Queryable = Pick<pg.Pool, 'query'>;
