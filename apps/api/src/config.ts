import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  SALE_ID: z.string().min(1).default('flash'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** How often each instance re-reads the sale row (docs/PLAN.md §6, filter 3). */
  SALE_REFRESH_MS: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Fail at boot with the field names, rather than at the first request with
    // a stack trace about undefined.
    throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
