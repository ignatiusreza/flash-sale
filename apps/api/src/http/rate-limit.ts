import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

export interface LimitSpec {
  readonly max: number;
  /** Milliseconds. Defaults to a minute. */
  readonly timeWindow?: number;
  /** Defaults to the client address. */
  readonly keyGenerator?: (request: FastifyRequest) => string;
}

/**
 * Builds a `preHandler` hook that applies several rate limits in order.
 *
 * Fastify's equivalent of Express middleware is a lifecycle hook, and
 * `@fastify/rate-limit` exposes `app.rateLimit()` as exactly that — but **only
 * one per route**. A second hook in the same `preHandler` array is silently
 * ignored: measured at user-max=2, four requests all returned 200 when an IP
 * limiter preceded it, and adding distinct `groupId`s changed nothing. Believing
 * otherwise would mean shipping half the limiting you think you have.
 *
 * So the verdicts come from `createRateLimit`, which does support several, and
 * this composes them into the one hook the route attaches. The handler is then
 * free of limiting entirely, and any other route can reuse this.
 *
 * Limits are checked in the order given and the first exceeded one wins, which
 * matters: stopping early means a flood on the first dimension does not also
 * consume the quota of the later ones.
 */
export function rateLimit(
  app: FastifyInstance,
  specs: readonly LimitSpec[],
): preHandlerAsyncHookHandler {
  const limiters = specs.map((spec) =>
    app.createRateLimit({
      max: spec.max,
      timeWindow: spec.timeWindow ?? 60_000,
      ...(spec.keyGenerator ? { keyGenerator: spec.keyGenerator } : {}),
    }),
  );

  return async (request, reply) => {
    for (const limiter of limiters) {
      const verdict = await limiter(request);

      // `isExceeded` is the verdict, not `isAllowed`. The latter reads like the
      // answer but is false even for a request well inside the limit — measured
      // at max=2, calls 1 and 2 both report isAllowed=false, isExceeded=false.
      if (verdict.isAllowed || !verdict.isExceeded) continue;

      // `createRateLimit` returns the verdict but, unlike the route-level hook,
      // sets no headers. Telling the client when to come back matters: during a
      // flash sale, a client left to guess retries immediately.
      return reply
        .code(429)
        .header('retry-after', String(verdict.ttlInSeconds))
        .header('x-ratelimit-limit', String(verdict.max))
        .header('x-ratelimit-remaining', String(verdict.remaining))
        .header('x-ratelimit-reset', String(verdict.ttlInSeconds))
        .send({ error: 'rate_limited' });
    }
  };
}
