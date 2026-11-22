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
  /** Backoff between retries of a failing batch, doubling up to the cap. */
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
  /**
   * Whether a failure belongs to the batch rather than to the moment — bad
   * data, not an outage. Such a batch is never retried as it is: it is split
   * until the attempt responsible is alone, and that one is dead-lettered.
   * Everything else is retried in place. Defaults to nothing being permanent.
   */
  readonly isPermanent?: (error: unknown) => boolean;
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
  const retryMinMs = options.retryMinMs ?? 100;
  const retryMaxMs = options.retryMaxMs ?? 10_000;
  const isPermanent = options.isPermanent ?? (() => false);

  // Prefetch must exceed the batch size: at exactly batchMax the broker stops
  // sending the moment a batch is assembled, and the consumer idles through the
  // commit instead of accumulating the next one.
  await channel.prefetch(batchMax * 2);

  const pending: ConsumeMessage[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let wake: (() => void) | undefined;

  /** A backoff that `stop()` cuts short. */
  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

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
    // At most batchMax: deliveries keep arriving while the previous batch
    // commits, or retries, and taking all of them would let a batch grow to
    // the whole prefetch. The rest go next, without waiting for the timer.
    const batch = pending.splice(0, batchMax);
    if (pending.length > 0) scheduleFlush();
    if (batch.length === 0) return;

    const attempts: PurchaseAttempt[] = [];
    const parsed: ConsumeMessage[] = [];
    for (const message of batch) {
      const attempt = parseAttempt(message);
      if (attempt) {
        attempts.push(attempt);
        parsed.push(message);
      } else {
        // Malformed will never become well-formed, and a batch is retried until
        // it succeeds, so it must not reach the claim: dead-letter it.
        onError(new Error(`malformed attempt: ${message.content.toString().slice(0, 200)}`));
        channel.reject(message, false);
      }
    }
    if (attempts.length === 0) return;

    await settle(parsed, attempts);
  }

  /**
   * Handles one run of attempts and settles every one of its messages.
   * Resolves false if stopped before it could, having handed them back.
   *
   * A failure that will pass is retried here, held unacked, never handed back:
   * a requeue counts as a delivery, and the queue drops a message past its
   * delivery limit — a database outage would cycle every accepted attempt into
   * nothing within seconds. Held, the batch fills the prefetch, the broker
   * stops delivering, the queue fills to its bound and the API sheds with 503.
   * If the process dies instead, the broker redelivers it.
   *
   * A failure that will not pass must not be held, or one bad attempt stops
   * every purchase behind it for good (issue #17). The run is halved until the
   * attempt responsible is alone, and only that one is dead-lettered; the
   * others are claimed as usual.
   */
  async function settle(messages: ConsumeMessage[], attempts: PurchaseAttempt[]): Promise<boolean> {
    for (let delay = retryMinMs; ; delay = Math.min(delay * 2, retryMaxMs)) {
      try {
        await handle(attempts);
        break;
      } catch (error) {
        onError(error);
        if (isPermanent(error)) {
          if (messages.length === 1) {
            channel.reject(messages[0]!, false);
            return true;
          }
          const half = Math.ceil(messages.length / 2);
          if (!(await settle(messages.slice(0, half), attempts.slice(0, half)))) {
            // Stopped in the first half: the second must go back as well, or
            // a later ack would swallow it.
            for (const message of messages.slice(half)) channel.nack(message, false, true);
            return false;
          }
          return settle(messages.slice(half), attempts.slice(half));
        }
        if (!stopped) await pause(delay);
        if (stopped) {
          // Stopping mid-outage: hand the batch back, to the front of the
          // queue, for the next consumer. Left unacked, a later batch's ack —
          // which covers every delivery up to its own — would swallow it.
          for (const message of messages) channel.nack(message, false, true);
          return false;
        }
      }
    }

    // Only now. Commit-then-die is safe: the batch is redelivered and the claim
    // makes the replay a no-op. Ack-then-commit would lose purchases. Every
    // earlier delivery is settled by now, halves included, so one ack covers
    // this run without reaching past it.
    const last = messages[messages.length - 1];
    if (last) channel.ack(last, true);
    return true;
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
      wake?.();
      await channel.cancel(consumerTag);
      scheduleFlush();
      await flushing;
    },
  };
}

function parseAttempt(message: ConsumeMessage): PurchaseAttempt | undefined {
  let value: unknown;
  try {
    value = JSON.parse(message.content.toString());
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const ok = ['attemptId', 'saleId', 'userId', 'requestedAt'].every(
    (key) => typeof fields[key] === 'string' && fields[key] !== '',
  );
  return ok ? (value as PurchaseAttempt) : undefined;
}
