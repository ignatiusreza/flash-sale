import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  /**
   * Which environment's data this process works on: `development`, `test`,
   * `e2e` or `production`. Separate from NODE_ENV, which says how the code
   * runs — E2E runs production code against test data. It prefixes the queue
   * and exchange names (`topologyNames` in @flash-sale/messaging); production
   * keeps the plain ones.
   */
  APP_ENV: z.string().default('production'),
  /**
   * Overrides the attempts queue's length bound, past which the API sheds with
   * 503. Only so the stress suite can reach it in seconds; the worker must use
   * the same value, or declaring the queue fails (`assertTopology`).
   */
  QUEUE_MAX_LENGTH: z.coerce.number().int().positive().optional(),
  SALE_ID: z.string().min(1).default('flash'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** How often each instance re-reads the sale row (docs/PLAN.md §6, filter 3). */
  SALE_REFRESH_MS: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /**
   * The log level. At `info`, Fastify logs every request — two lines each,
   * written synchronously, on the hot path; `warn` keeps errors and warnings
   * only.
   */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Prints where this process's time goes every so many milliseconds, for the
   * stress harness (`@flash-sale/stats`). Unset, nothing is measured.
   */
  STATS_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  /**
   * Per address, for `GET /api/orders`. Higher than purchases: a client looks
   * itself up on every connect, and a reconnect or a refresh is legitimate.
   * It is there so one client cannot turn the lookup into load on the database
   * the worker claims against.
   */
  ORDER_LOOKUP_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /**
   * Directory of the built SPA. Unset, this is a pure API process and serving
   * the frontend is someone else's job — a CDN, or another route on the
   * gateway (docs/PLAN.md §12.1).
   */
  WEB_ROOT: z.string().min(1).optional(),
  /**
   * Which peers may be believed when they send `X-Forwarded-For`. This decides
   * what `request.ip` is, and `request.ip` is what the rate limiter keys on
   * (docs/PLAN.md §6), so it is a security setting rather than a formality.
   *
   * Off by default. `true` trusts the whole chain, which means the client
   * picks its own address and can mint a fresh bucket per request — only safe
   * where nothing but the gateway can reach this process and the gateway
   * overwrites the header. Naming the proxies as a comma-separated list of
   * addresses, CIDRs or presets (`loopback`, `uniquelocal`) is the safe form.
   */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value, ctx): boolean | string[] => {
      if (value === undefined || value === '' || value === 'false' || value === '0') return false;
      if (value === 'true') return true;
      // Fastify maps a hop count to a function that trusts nothing, on the
      // grounds that hop counts cannot validate the immediate peer. Accepting
      // one here would read as "configured" while trusting nobody.
      if (/^\d+$/.test(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `TRUST_PROXY does not take a hop count (${value}); Fastify ignores it and trusts nothing. Use true, or a list of proxy addresses/CIDRs.`,
        });
        return false;
      }
      return value.split(',').map((v) => v.trim());
    }),
});

export type Config = z.infer<typeof schema>;

/**
 * Whether to register `POST /api/test/sale`, which wipes the sale's orders and
 * reseeds it for the E2E suite. Only in the E2E environment: not development,
 * whose data is someone's work, and never production.
 */
export function testEndpointsEnabled(config: Pick<Config, 'APP_ENV'>): boolean {
  return config.APP_ENV === 'e2e';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Fail at boot with the field names, rather than at the first request with
    // a stack trace about undefined.
    throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
