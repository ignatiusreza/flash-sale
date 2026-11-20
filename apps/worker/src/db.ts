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
  });
}

export type Queryable = Pick<pg.Pool, 'query'>;
