import type { PurchaseAttempt, PurchaseResultsMessage } from '@flash-sale/core';
import type { ConfirmChannel } from 'amqplib';

/** Raised when the broker refuses a publish — queue full, or nacked. */
export class PublishRejected extends Error {
  constructor(reason: string) {
    super(`publish rejected: ${reason}`);
    this.name = 'PublishRejected';
  }
}

function publishConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  body: unknown,
  options: { persistent: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // A `false` return means the channel's write buffer is full, which is
    // backpressure rather than refusal — the confirm callback still fires
    // either way, so waiting on that is the whole of it.
    channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(body)),
      { persistent: options.persistent, contentType: 'application/json' },
      (error) => (error ? reject(new PublishRejected(String(error))) : resolve()),
    );
  });
}

/**
 * Publishes a purchase attempt and resolves only once the broker has confirmed
 * it. Without that confirmation a "published" attempt can vanish and the user
 * waits forever for a result that will never come (docs/PLAN.md §5) — so the
 * API must not return 202 until this resolves.
 *
 * Rejects with {@link PublishRejected} when the queue is at its bound, which is
 * the signal to shed load with a 503 rather than retry.
 */
export async function publishAttempt(
  channel: ConfirmChannel,
  queue: string,
  attempt: PurchaseAttempt,
): Promise<void> {
  // Default exchange + routing key = queue name: a direct publish to the queue.
  await publishConfirmed(channel, '', queue, attempt, { persistent: true });
}

/**
 * Fans a batch's outcomes out to every API instance. Not confirmed: a lost
 * result is cosmetic, because the client re-syncs through
 * `GET /api/purchase/:userId` on reconnect (§5), and waiting on confirms here
 * would put broker latency between the commit and the user hearing about it.
 */
export function publishResults(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  message: PurchaseResultsMessage,
): void {
  channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(message)), {
    persistent: false,
    contentType: 'application/json',
  });
}
