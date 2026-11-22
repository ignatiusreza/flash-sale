import type { PurchaseAttempt } from './contracts.js';
import type { Channel, ConsumeMessage } from 'amqplib';

export interface BatchConsumerOptions {
  readonly channel: Channel;
  readonly queue: string;
  /** Flush once this many attempts have accumulated. */
  readonly batchMax?: number;
  /** ...or this many milliseconds after the first one, whichever comes first. */
  readonly flushMs?: number;
  /** Processes one batch. Must have committed before it resolves. */
  readonly handle: (attempts: PurchaseAttempt[]) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface BatchConsumer {
  /** Resolves once every in-flight batch has settled. */
  stop: () => Promise<void>;
  readonly consumerTag: string;
}

/**
 * Consumes attempts in batches, because a claim per message pays an fsync per
 * purchase: measured at 835/s unbatched against ~37 000/s batched
 * (docs/PLAN.md §4.3).
 *
 * The size-or-time trigger makes this self-tuning. Under light load the timer
 * fires first, so batches are small and latency is ~`flushMs`. Under a burst
 * the size trigger fires first, so batches are full and throughput is maximal.
 * Nobody has to choose between the two up front.
 *
 * Hence a large `batchMax`: it only costs latency when batches fill, which is
 * when throughput matters. Draining the worker path measured ~31 000 claims/s
 * at 100, ~44 000 at 500 and ~53 000 at 1000; 500 takes most of the gain while
 * keeping a redelivered batch modest.
 */
export async function startBatchConsumer(options: BatchConsumerOptions): Promise<BatchConsumer> {
  const { channel, queue, handle } = options;
  const batchMax = options.batchMax ?? 500;
  const flushMs = options.flushMs ?? 5;
  const onError = options.onError ?? (() => {});

  // Prefetch must exceed the batch size: at exactly batchMax the broker stops
  // sending the moment a batch is assembled, and the consumer idles through the
  // commit instead of accumulating the next one.
  await channel.prefetch(batchMax * 2);

  let pending: ConsumeMessage[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  // Batches must never overlap. `ack(msg, true)` acks everything up to that
  // delivery tag, so two in flight at once would ack a batch whose transaction
  // has not committed. Chaining through one promise removes the whole class.
  let flushing: Promise<void> = Promise.resolve();

  function scheduleFlush(): void {
    flushing = flushing.then(flush).catch(onError);
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;

    const attempts: PurchaseAttempt[] = [];
    const parsed: ConsumeMessage[] = [];
    for (const message of batch) {
      try {
        attempts.push(JSON.parse(message.content.toString()) as PurchaseAttempt);
        parsed.push(message);
      } catch (error) {
        // Unparseable will never become parseable; requeueing it would spin.
        onError(error);
        channel.reject(message, false);
      }
    }
    if (attempts.length === 0) return;

    try {
      await handle(attempts);
    } catch (error) {
      onError(error);
      // Nothing committed, so put them back for the next consumer. Individual
      // nacks, not allUpTo, because `parsed` may have gaps where a message was
      // rejected above and acking past it would swallow the gap.
      for (const message of parsed) channel.nack(message, false, true);
      return;
    }

    // Only now. Commit-then-die is safe: the batch is redelivered and the claim
    // makes the replay a no-op. Ack-then-commit would lose purchases.
    const last = parsed[parsed.length - 1];
    if (last) channel.ack(last, true);
  }

  const { consumerTag } = await channel.consume(
    queue,
    (message) => {
      if (!message || stopped) return;
      pending.push(message);
      if (pending.length >= batchMax) scheduleFlush();
      else timer ??= setTimeout(scheduleFlush, flushMs);
    },
    { noAck: false },
  );

  return {
    consumerTag,
    stop: async () => {
      stopped = true;
      await channel.cancel(consumerTag);
      scheduleFlush();
      await flushing;
    },
  };
}
