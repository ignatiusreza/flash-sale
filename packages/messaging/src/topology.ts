import {
  ATTEMPTS_QUEUE,
  ATTEMPTS_QUEUE_ARGS,
  EVENTS_EXCHANGE,
  ROUTING_KEY_RESULTS,
} from '@flash-sale/core';
import type { Channel } from 'amqplib';

export { ATTEMPTS_QUEUE, EVENTS_EXCHANGE, ROUTING_KEY_RESULTS };

/**
 * Declares everything both sides depend on. Idempotent, so every process can
 * assert it on boot and none has to be "the one that sets up the broker".
 *
 * `maxLength` is overridable only so tests can drive saturation without
 * queueing a hundred thousand messages.
 */
export async function assertTopology(
  channel: Channel,
  options: { queue?: string; exchange?: string; maxLength?: number } = {},
): Promise<{ queue: string; exchange: string }> {
  const queue = options.queue ?? ATTEMPTS_QUEUE;
  const exchange = options.exchange ?? EVENTS_EXCHANGE;

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
