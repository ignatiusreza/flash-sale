import type { Channel } from 'amqplib';

import { ATTEMPTS_QUEUE, ATTEMPTS_QUEUE_ARGS, EVENTS_EXCHANGE } from './contracts.js';

const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The queue and exchange names for an `APP_ENV`: `<environment>.<name>`, or the
 * plain names in production (or with none set), so a deployed broker keeps the
 * names it has.
 *
 * Environments sharing a broker each get their own, as each gets its own
 * database — so a development worker never consumes an E2E run's attempts, and
 * presence counts never mix. A virtual host per environment would be the more
 * literal split, but creating one needs broker admin rights; names are
 * declared on first use.
 */
export function topologyNames(environment?: string): { queue: string; exchange: string } {
  if (!environment || environment === 'production') {
    return { queue: ATTEMPTS_QUEUE, exchange: EVENTS_EXCHANGE };
  }
  if (!ENVIRONMENT.test(environment)) {
    throw new Error(`invalid APP_ENV "${environment}": use [a-z0-9_-], not leading _ or -`);
  }
  return {
    queue: `${environment}.${ATTEMPTS_QUEUE}`,
    exchange: `${environment}.${EVENTS_EXCHANGE}`,
  };
}

/**
 * Declares everything both sides depend on. Idempotent, so every process can
 * assert it on boot and none has to be "the one that sets up the broker".
 *
 * `maxLength` is overridable only so tests can drive saturation without
 * queueing a hundred thousand messages; explicit names, only so tests can use
 * a queue per test.
 */
export async function assertTopology(
  channel: Channel,
  options: { environment?: string; queue?: string; exchange?: string; maxLength?: number } = {},
): Promise<{ queue: string; exchange: string }> {
  const names = topologyNames(options.environment);
  const queue = options.queue ?? names.queue;
  const exchange = options.exchange ?? names.exchange;

  await channel.assertExchange(exchange, 'fanout', { durable: true });

  await channel.assertQueue(queue, {
    durable: true,
    arguments: {
      ...ATTEMPTS_QUEUE_ARGS,
      ...(options.maxLength === undefined ? {} : { 'x-max-length': options.maxLength }),
    },
  });

  return { queue, exchange };
}
