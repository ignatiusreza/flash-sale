import type { Channel, ConfirmChannel } from 'amqplib';

import { ROUTING_KEY_PRESENCE, ROUTING_KEY_RESULTS, type PresenceMessage } from './contracts.js';

export interface EventHandlers {
  readonly onResults?: (message: unknown) => void;
  readonly onPresence?: (message: PresenceMessage) => void;
}

export interface Subscription {
  readonly queue: string;
  stop: () => Promise<void>;
}

/**
 * Subscribes this process to the events fanout.
 *
 * The queue is exclusive and auto-delete on purpose: it belongs to one API
 * instance and should vanish with it. Nothing here is worth keeping across a
 * restart — a missed result is recovered by the client re-syncing through
 * `GET /api/purchase/:userId`, which is what makes a dropped socket cosmetic
 * (docs/PLAN.md §5).
 *
 * Messages are *not* acknowledged individually (`noAck`): redelivering a
 * presence count or a result the recipient already applied buys nothing, and
 * acking would only add round trips to the path between a commit and the user
 * hearing about it.
 */
export async function subscribeToEvents(
  channel: Channel,
  exchange: string,
  handlers: EventHandlers,
): Promise<Subscription> {
  const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
  await channel.bindQueue(queue, exchange, ROUTING_KEY_RESULTS);
  await channel.bindQueue(queue, exchange, ROUTING_KEY_PRESENCE);

  const { consumerTag } = await channel.consume(
    queue,
    (message) => {
      if (!message) return;
      let payload: unknown;
      try {
        payload = JSON.parse(message.content.toString());
      } catch {
        // Unparseable will never become parseable, and there is nothing to
        // nack with noAck — drop it rather than throwing inside the consumer.
        return;
      }

      if (message.fields.routingKey === ROUTING_KEY_RESULTS) {
        handlers.onResults?.(payload);
      } else if (message.fields.routingKey === ROUTING_KEY_PRESENCE) {
        handlers.onPresence?.(payload as PresenceMessage);
      }
    },
    { noAck: true },
  );

  return {
    queue,
    stop: async () => {
      await channel.cancel(consumerTag).catch(() => {});
    },
  };
}

/** Announces this instance's socket count to every other instance. */
export function publishPresence(
  channel: ConfirmChannel,
  exchange: string,
  message: PresenceMessage,
): void {
  channel.publish(exchange, ROUTING_KEY_PRESENCE, Buffer.from(JSON.stringify(message)), {
    persistent: false,
    contentType: 'application/json',
  });
}
