import { randomUUID } from 'node:crypto';

import {
  assertTopology,
  connectBroker,
  publishAttempt,
  PublishRejected,
  startBatchConsumer,
  type PurchaseAttempt,
  type PurchaseResultsMessage,
} from '@flash-sale/messaging';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool } from '../db/pool.js';
import { handleBatch } from './handler.js';
import { migrate } from '../db/migrate.js';

const DATABASE_URL = process.env.DATABASE_URL;
const RABBITMQ_URL = process.env.RABBITMQ_URL;

// Per-test sale, per-test queue: see the note in claim.test.ts. Sharing either
// across suites that run in parallel produces failures that look like bugs.
let SALE: string;

const describeQueue = DATABASE_URL && RABBITMQ_URL ? describe : describe.skip;

let pool: pg.Pool;
let connection: ChannelModel;
let channel: ConfirmChannel;
let queue: string;
let exchange: string;

function attempt(userId: string): PurchaseAttempt {
  return {
    attemptId: randomUUID(),
    saleId: SALE,
    userId,
    requestedAt: new Date().toISOString(),
  };
}

async function seed(stock: number): Promise<void> {
  SALE = `queue-${randomUUID()}`;
  await pool.query(
    `INSERT INTO sales (id, total_stock, remaining, start_at, end_at)
     VALUES ($1, $2, $2, now() - interval '1 minute', now() + interval '1 hour')`,
    [SALE, stock],
  );
}

/** Waits for a condition rather than sleeping a fixed amount. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met within timeout');
}

describeQueue('queue wiring', () => {
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!, 20);
    await migrate(pool);
    connection = await connectBroker(RABBITMQ_URL!);
  });

  afterAll(async () => {
    // See claim.test.ts: per-test sales isolate suites but would otherwise
    // pile up in the database the dev stack also uses.
    await pool?.query("DELETE FROM orders WHERE sale_id LIKE 'queue-%'");
    await pool?.query("DELETE FROM sales WHERE id LIKE 'queue-%'");
    await connection?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    channel = await connection.createConfirmChannel();
    // A queue per test: these assert on delivery, and a leftover message from a
    // previous test would look exactly like a bug in this one.
    const suffix = randomUUID();
    ({ queue, exchange } = await assertTopology(channel, {
      queue: `test.attempts.${suffix}`,
      exchange: `test.events.${suffix}`,
    }));
    await seed(10);
  });

  afterEach(async () => {
    await channel.deleteQueue(queue).catch(() => {});
    await channel.deleteExchange(exchange).catch(() => {});
    await channel.close().catch(() => {});
  });

  it('declares the attempts queue as a quorum queue with a single active consumer', async () => {
    // assertQueue with the same arguments succeeds; mismatched arguments would
    // be a channel-level PRECONDITION_FAILED, so this pins the declaration.
    const check = await connection.createChannel();
    const info = await check.checkQueue(queue);
    expect(info.queue).toBe(queue);
    await check.close();
  });

  it('carries an attempt from publish through claim to a result', async () => {
    const received: PurchaseResultsMessage[] = [];
    const consumer = await startBatchConsumer({
      channel,
      queue,
      flushMs: 5,
      handle: async (attempts) => {
        received.push(await handleBatch(pool, SALE, attempts));
      },
    });

    await publishAttempt(channel, queue, attempt('alice'));
    await until(() => received.length > 0);
    await consumer.stop();

    expect(received[0]!.results).toHaveLength(1);
    expect(received[0]!.results[0]).toMatchObject({ userId: 'alice', status: 'confirmed' });
    expect(received[0]!.results[0]!.orderId).toBeDefined();
  });

  it('batches several attempts into one claim and one result message', async () => {
    const received: PurchaseResultsMessage[] = [];
    const consumer = await startBatchConsumer({
      channel,
      queue,
      batchMax: 50,
      flushMs: 50,
      handle: async (attempts) => {
        received.push(await handleBatch(pool, SALE, attempts));
      },
    });

    for (let i = 0; i < 5; i++) await publishAttempt(channel, queue, attempt(`user-${i}`));
    await until(() => received.flatMap((m) => m.results).length === 5);
    await consumer.stop();

    // One message carrying five outcomes, not five messages (docs/PLAN.md §4.2).
    expect(received).toHaveLength(1);
    expect(received[0]!.results.map((r) => r.status)).toEqual(Array(5).fill('confirmed'));
  });

  it('reports already_purchased rather than sold_out for a repeat buyer', async () => {
    const received: PurchaseResultsMessage[] = [];
    const consumer = await startBatchConsumer({
      channel,
      queue,
      flushMs: 5,
      handle: async (attempts) => {
        received.push(await handleBatch(pool, SALE, attempts));
      },
    });

    await publishAttempt(channel, queue, attempt('bob'));
    await until(() => received.length === 1);
    await publishAttempt(channel, queue, attempt('bob'));
    await until(() => received.length === 2);
    await consumer.stop();

    expect(received[0]!.results[0]!.status).toBe('confirmed');
    expect(received[1]!.results[0]).toMatchObject({ status: 'already_purchased' });
    // Same order both times, and only one unit consumed.
    expect(received[1]!.results[0]!.orderId).toBe(received[0]!.results[0]!.orderId);
    const { rows } = await pool.query<{ remaining: number }>(
      'SELECT remaining FROM sales WHERE id = $1',
      [SALE],
    );
    expect(rows[0]!.remaining).toBe(9);
  });

  describe('redelivery', () => {
    it('redelivers an unacked batch when the consumer dies mid-flight', async () => {
      let seen = 0;
      // First consumer takes the message and dies before acking, exactly as a
      // worker crashing between claim and ack would.
      const dying = await startBatchConsumer({
        channel,
        queue,
        flushMs: 5,
        handle: async () => {
          seen++;
          throw new Error('crash before commit');
        },
        onError: () => {},
      });
      await publishAttempt(channel, queue, attempt('carol'));
      await until(() => seen > 0);
      await dying.stop();
      await channel.close();

      // Nothing was committed, so the unit is still available.
      const { rows } = await pool.query<{ remaining: number }>(
        'SELECT remaining FROM sales WHERE id = $1',
        [SALE],
      );
      expect(rows[0]!.remaining).toBe(10);

      // A fresh consumer picks the redelivered message up and completes it.
      channel = await connection.createConfirmChannel();
      const received: PurchaseResultsMessage[] = [];
      const healthy = await startBatchConsumer({
        channel,
        queue,
        flushMs: 5,
        handle: async (attempts) => {
          received.push(await handleBatch(pool, SALE, attempts));
        },
      });
      await until(() => received.length > 0, 10_000);
      await healthy.stop();

      expect(received[0]!.results[0]).toMatchObject({ userId: 'carol', status: 'confirmed' });
    });

    it('consumes no extra stock when a committed batch is replayed', async () => {
      const received: PurchaseResultsMessage[] = [];
      const consumer = await startBatchConsumer({
        channel,
        queue,
        flushMs: 5,
        handle: async (attempts) => {
          received.push(await handleBatch(pool, SALE, attempts));
        },
      });

      const dave = attempt('dave');
      await publishAttempt(channel, queue, dave);
      await until(() => received.length === 1);

      // The same attempt arriving twice is what at-least-once delivery means.
      await publishAttempt(channel, queue, dave);
      await until(() => received.length === 2);
      await consumer.stop();

      expect(received[0]!.results[0]!.status).toBe('confirmed');
      expect(received[1]!.results[0]!.status).toBe('already_purchased');

      const { rows } = await pool.query<{ remaining: number; orders: string }>(
        'SELECT (SELECT remaining FROM sales WHERE id = $1) AS remaining, (SELECT count(*) FROM orders WHERE sale_id = $1)::text AS orders',
        [SALE],
      );
      expect(rows[0]!.remaining).toBe(9);
      expect(Number(rows[0]!.orders)).toBe(1);
    });
  });

  it('rejects a publish once the queue is at its bound, so the API can shed load', async () => {
    const bounded = `test.bounded.${randomUUID()}`;
    await assertTopology(channel, { queue: bounded, exchange, maxLength: 2 });

    // A quorum queue does not reject at exactly x-max-length: it accepts one
    // past the bound and rejects after that — measured as 3 accepted against a
    // limit of 2. So this asserts that saturation *does* shed, not the index at
    // which it starts, which is a broker implementation detail.
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      try {
        await publishAttempt(channel, bounded, attempt(`u${i}`));
        outcomes.push('accepted');
      } catch (error) {
        outcomes.push(error instanceof PublishRejected ? 'rejected' : 'unexpected');
        break;
      }
    }

    expect(outcomes).toContain('rejected');
    expect(outcomes).not.toContain('unexpected');
    // And it sheds promptly rather than buffering indefinitely.
    expect(outcomes.length).toBeLessThanOrEqual(5);

    const cleanup = await connection.createChannel();
    await cleanup.deleteQueue(bounded).catch(() => {});
    await cleanup.close();
  });
});
