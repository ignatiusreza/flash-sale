import type { Channel, ChannelModel } from 'amqplib';

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
): Promise<{ queue: string; exchange: string; deadLetterQueue: string }> {
  const names = topologyNames(options.environment);
  const queue = options.queue ?? names.queue;
  const exchange = options.exchange ?? names.exchange;
  // Where attempts go that can never be claimed, or outlived the delivery
  // limit. Nothing consumes it: it is for an operator to inspect and replay.
  const deadLetterQueue = `${queue}.dead`;

  await channel.assertExchange(exchange, 'fanout', { durable: true });
  await channel.assertQueue(deadLetterQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });

  await channel.assertQueue(queue, {
    durable: true,
    arguments: {
      ...ATTEMPTS_QUEUE_ARGS,
      ...(options.maxLength === undefined ? {} : { 'x-max-length': options.maxLength }),
      // The default exchange routes by queue name.
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': deadLetterQueue,
    },
  });

  return { queue, exchange, deadLetterQueue };
}

type TopologyOptions = Parameters<typeof assertTopology>[1];

/**
 * `assertTopology` for startup: first replaces an attempts queue declared with
 * different arguments, by an earlier version, if it is empty.
 *
 * RabbitMQ refuses to redeclare a queue with other arguments; deleting it is
 * the only way to change them. Quorum queues have no atomic delete-if-empty,
 * so this checks and then deletes: safe once nothing of the earlier version
 * still publishes — new API instances cannot until the queue is replaced, so
 * stop the old ones first, as every script and Compose do. A queue that still
 * holds attempts is left alone and startup fails: let the old worker drain it.
 *
 * Takes the connection because the refusal closes the channel it happens on.
 */
export async function declareTopology(
  connection: ChannelModel,
  options: TopologyOptions = {},
): Promise<Awaited<ReturnType<typeof assertTopology>>> {
  try {
    return await withChannel(connection, (channel) => assertTopology(channel, options));
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
  }

  const queue = options.queue ?? topologyNames(options.environment).queue;
  await withChannel(connection, async (channel) => {
    const { messageCount } = await channel.checkQueue(queue);
    if (messageCount > 0) {
      throw new Error(
        `queue ${queue} was declared with other arguments and is not empty ` +
          `(${messageCount} waiting); let the previous worker drain it, then start again`,
      );
    }
    await channel.deleteQueue(queue);
  });
  return withChannel(connection, (channel) => assertTopology(channel, options));
}
async function withChannel<T>(
  connection: ChannelModel,
  use: (channel: Channel) => Promise<T>,
): Promise<T> {
  const channel = await connection.createChannel();
  // A refused declaration closes the channel with an error event as well as
  // rejecting; the rejection carries the detail, so the event is not needed.
  channel.on('error', () => {});
  try {
    return await use(channel);
  } finally {
    await channel.close().catch(() => {});
  }
}

function isPreconditionFailed(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 406;
}
