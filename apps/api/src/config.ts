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
