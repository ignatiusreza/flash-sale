import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { buildServer } from '../server.js';
import type { SaleCache, SaleView } from '../sale/cache.js';

/**
 * Shared fixtures for the route tests.
 *
 * Excluded from the build alongside the tests themselves — it imports nothing
 * from `vitest`, but it exists only for them and has no business in `dist`.
 */

export const WINDOW = {
  startAt: '2026-11-20T10:00:00.000Z',
  endAt: '2026-11-20T11:00:00.000Z',
} as const;

export const activeView: SaleView = { status: 'active', availability: 'plenty', ...WINDOW };

/** A cache stub: the route tests are about routing and admission, not Postgres. */
export function cacheOf(view: SaleView | undefined): SaleCache {
  return { view: () => view, healthy: view !== undefined } as unknown as SaleCache;
}

export interface TestServerOptions {
  /** Omit the key entirely for the default active sale; pass `undefined` for none. */
  view?: SaleView | undefined;
  pool?: pg.Pool;
  rateLimitPerMinute?: number;
  lookupLimitPerMinute?: number;
  publish?: (attempt: unknown) => Promise<void>;
  /** Directory of a built SPA. Omitted, the server is API-only. */
  webRoot?: string;
  trustProxy?: boolean | string[];
  /** Replaces the stub built from `view`, for tests that need more of the cache. */
  saleCache?: SaleCache;
  enableTestEndpoints?: boolean;
  docs?: boolean;
}

export interface TestServer {
  app: FastifyInstance;
  /** Attempts the server published, in order. */
  published: unknown[];
}

export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const published: unknown[] = [];
  const publish =
    options.publish ??
    (async (attempt: unknown) => {
      published.push(attempt);
    });

  const app = await buildServer({
    pool: options.pool ?? ({} as pg.Pool),
    saleCache: options.saleCache ?? cacheOf('view' in options ? options.view : activeView),
    saleId: 'flash',
    rateLimitPerMinute: options.rateLimitPerMinute ?? 1000,
    lookupLimitPerMinute: options.lookupLimitPerMinute ?? 1000,
    publish,
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
    ...(options.enableTestEndpoints ? { enableTestEndpoints: true } : {}),
    ...(options.docs === undefined ? {} : { docs: options.docs }),
  });

  return { app, published };
}
