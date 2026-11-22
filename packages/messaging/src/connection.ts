import amqp, { type ChannelModel } from 'amqplib';

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
