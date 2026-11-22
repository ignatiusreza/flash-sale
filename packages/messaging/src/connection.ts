import amqp, { type Channel, type ChannelModel } from 'amqplib';

/**
 * Connects to the broker with Nagle's algorithm off.
 *
 * amqplib leaves it on, and both sides here write in small back-to-back
 * pieces: the worker publishes a batch's results and then acks the batch, the
 * API publishes an attempt and waits for its confirm. With Nagle on, the
 * second write waits for the peer to acknowledge the first, which delayed-ACK
 * holds back — measured at ~20 ms per worker batch, capping it at ~4 300
 * claims/s against ~33 000 with it off (docs/PLAN.md §11, stress).
 */
export function connectBroker(url: string): Promise<ChannelModel> {
  return amqp.connect(url, { noDelay: true });
}

/**
 * Calls `onLost` when the connection or any of these channels closes, unless
 * the returned function was called first to mark a deliberate shutdown.
 *
 * Recovery is crash-only: the process exits and its supervisor restarts it.
 * Reconnecting in place would mean rebuilding every channel, consumer and
 * subscription with the state each had, which is a lot of rarely-run code; a
 * restart rebuilds all of it the way every boot does. Unacked attempts go back
 * to the queue, and clients reconnect and re-sync.
 */
export function onBrokerLost(
  connection: ChannelModel,
  channels: readonly Channel[],
  onLost: (reason: string) => void,
): () => void {
  let closing = false;
  let lastError = '';
  const remember = (error: Error) => {
    lastError = `: ${error.message}`;
  };
  const lost = (what: string) => () => {
    if (!closing) onLost(`broker ${what} closed${lastError}`);
  };
  // amqplib emits `error` then `close`; without an `error` listener the
  // process dies on an unhandled event before `close` can be handled.
  connection.on('error', remember);
  connection.on('close', lost('connection'));
  for (const channel of channels) {
    channel.on('error', remember);
    channel.on('close', lost('channel'));
  }
  return () => {
    closing = true;
  };
}
