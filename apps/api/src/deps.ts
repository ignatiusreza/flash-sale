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
  /** Per address, for the order lookup; see `config.ts`. Defaults to 120. */
  readonly lookupLimitPerMinute?: number;
  /** Publishes an attempt and resolves only once the broker confirms it. */
  readonly publish: (attempt: Parameters<typeof publishAttempt>[2]) => Promise<void>;
  readonly logger?: boolean;
  /** Pino's level when `logger` is on; `info` logs every request. */
  readonly loggerLevel?: string;
  /** Serve the OpenAPI document and its UI. On by default. */
  readonly docs?: boolean;
  /** Directory of the built SPA. Unset, this serves the API alone. */
  readonly webRoot?: string;
  /** Registers the E2E-only reset endpoint; see `config.ts`. Off by default. */
  readonly enableTestEndpoints?: boolean;
  /** Whether `X-Forwarded-For` may be believed; see `config.ts`. */
  readonly trustProxy?: boolean | string[];
}
