import type { publishAttempt } from '@flash-sale/messaging';
import type pg from 'pg';

import type { SaleCache } from './sale/cache.js';

/**
 * What every route needs, passed as plugin options.
 *
 * It lives in its own module rather than in `server.ts` so route plugins can
 * import the type without importing the thing that registers them.
 */
export interface ServerDeps {
  readonly pool: pg.Pool;
  readonly saleCache: SaleCache;
  readonly saleId: string;
  readonly rateLimitPerMinute: number;
  /** Publishes an attempt and resolves only once the broker confirms it. */
  readonly publish: (attempt: Parameters<typeof publishAttempt>[2]) => Promise<void>;
  readonly logger?: boolean;
  /** Serve the OpenAPI document and its UI. On by default. */
  readonly docs?: boolean;
}
