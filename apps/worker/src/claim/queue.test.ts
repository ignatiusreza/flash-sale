import { randomUUID } from 'node:crypto';

import {
  assertTopology,
  connectBroker,
  declareTopology,
  publishAttempt,
  PublishRejected,
  startBatchConsumer,
  type PurchaseAttempt,
  type PurchaseResultsMessage,
} from '@flash-sale/messaging';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
let deadLetterQueue: string;

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
    ({ queue, exchange, deadLetterQueue } = await assertTopology(channel, {
      queue: `test.attempts.${suffix}`,
      exchange: `test.events.${suffix}`,
    }));
    await seed(10);
  });

  afterEach(async () => {
    await channel.deleteQueue(queue).catch(() => {});
    await channel.deleteQueue(deadLetterQueue).catch(() => {});
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

    it('consumes no extra stock when the same attempt arrives twice', async () => {
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

      // A double submit, or a publish the API retried: the same attempt twice.
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

  describe('a worker dying between commit and ack', () => {
    it('replays the batch to the next worker: the same order, no extra stock', async () => {
      // Its own connection, so closing it is the death of this worker alone.
      const dying = await connectBroker(RABBITMQ_URL!);
      dying.on('error', () => {});
      const dyingChannel = await dying.createConfirmChannel();
      dyingChannel.on('error', () => {});

      let committed: PurchaseResultsMessage | undefined;
      await startBatchConsumer({
        channel: dyingChannel,
        queue,
        flushMs: 5,
        onError: () => {},
        handle: async (attempts) => {
          committed = await handleBatch(pool, SALE, attempts);
          // Committed; now gone before the ack. The broker returns the
          // unacked delivery, and this handler never finishes to ack it.
          await dying.close();
          await new Promise(() => {});
        },
      });

      await publishAttempt(channel, queue, attempt('erin'));
      await until(() => committed !== undefined);
      const original = committed!.results[0]!;
      expect(original).toMatchObject({ userId: 'erin', status: 'confirmed' });

      const replayed: PurchaseResultsMessage[] = [];
      const next = await startBatchConsumer({
        channel,
        queue,
        flushMs: 5,
        handle: async (attempts) => {
          replayed.push(await handleBatch(pool, SALE, attempts));
        },
      });
      await until(() => replayed.length > 0, 10_000);
      await next.stop();

      // A success, with the order the first worker committed.
      expect(replayed[0]!.results[0]).toEqual({
        attemptId: original.attemptId,
        userId: 'erin',
        status: 'already_purchased',
        orderId: original.orderId,
      });
      const { rows } = await pool.query<{ remaining: number; orders: string }>(
        'SELECT (SELECT remaining FROM sales WHERE id = $1) AS remaining, (SELECT count(*) FROM orders WHERE sale_id = $1)::text AS orders',
        [SALE],
      );
      expect(rows[0]).toEqual({ remaining: 9, orders: '1' });
    });
  });

  describe('the invariants, through the queue and the worker', () => {
    it('sells exactly the stock, once per buyer, and every result matches an order', async () => {
      // The claim-level invariant tests (claim.test.ts) call the claim
      // directly; this is the path a purchase takes: published with confirms,
      // batched, claimed, and announced. A quarter of the attempts are
      // repeats by a buyer who already tried.
      const stock = 50;
      await pool.query('UPDATE sales SET total_stock = $2, remaining = $2 WHERE id = $1', [
        SALE,
        stock,
      ]);
      const attempts = Array.from({ length: 2_000 }, (_, i) =>
        attempt(`buyer-${i % 4 === 3 ? i - 1 : i}`),
      );

      const results: PurchaseResultsMessage['results'][number][] = [];
      const consumer = await startBatchConsumer({
        channel,
        queue,
        batchMax: 100,
        flushMs: 5,
        handle: async (batch) => {
          results.push(...(await handleBatch(pool, SALE, batch)).results);
        },
      });
      await Promise.all(attempts.map((a) => publishAttempt(channel, queue, a)));
      await until(() => results.length === attempts.length, 30_000);
      await consumer.stop();

      const { rows: orders } = await pool.query<{ user_id: string; id: string }>(
        'SELECT user_id, id FROM orders WHERE sale_id = $1',
        [SALE],
      );
      const { rows: sale } = await pool.query<{ remaining: number }>(
        'SELECT remaining FROM sales WHERE id = $1',
        [SALE],
      );

      // Exactly the stock, nothing left.
      expect(orders).toHaveLength(stock);
      expect(sale[0]!.remaining).toBe(0);

      // One result per attempt, none twice.
      expect(new Set(results.map((r) => r.attemptId)).size).toBe(attempts.length);

      // Every confirmation names a committed order, and every order was
      // confirmed: the same set, not merely no more of them. Distinct pairs,
      // because a buyer's repeats in one batch are each told `confirmed`,
      // with the one order they share.
      const confirmed = new Set(
        results.filter((r) => r.status === 'confirmed').map((r) => `${r.userId}:${r.orderId}`),
      );
      expect([...confirmed].sort()).toEqual(orders.map((o) => `${o.user_id}:${o.id}`).sort());

      // Nobody holding an order was told anything else, nor given another id.
      const held = new Map(orders.map((o) => [o.user_id, o.id]));
      for (const result of results) {
        const orderId = held.get(result.userId);
        if (orderId) {
          expect(['confirmed', 'already_purchased']).toContain(result.status);
          expect(result.orderId).toBe(orderId);
        } else {
          expect(result.status).toBe('sold_out');
        }
      }
    }, 60_000);
  });

  describe('nothing accepted is ever dropped', () => {
    async function depth(name: string): Promise<number> {
      const check = await connection.createChannel();
      const { messageCount } = await check.checkQueue(name);
      await check.close();
      return messageCount;
    }

    async function untilDepth(name: string, count: number): Promise<void> {
      const deadline = Date.now() + 10_000;
      while ((await depth(name)) !== count) {
        if (Date.now() > deadline) throw new Error(`${name} never reached ${count}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    it('holds a failing batch until the claim recovers, rather than cycling it away', async () => {
      // A database outage. Requeueing on each failure dropped every attempt
      // past the delivery limit of 20 on RabbitMQ 4.2, and spins at thousands
      // of redeliveries a second on 4.4; holding the batch does neither.
      const handBack = vi.spyOn(channel, 'nack');
      let failures = 0;
      const received: PurchaseResultsMessage[] = [];
      const consumer = await startBatchConsumer({
        channel,
        queue,
        flushMs: 5,
        retryMinMs: 1,
        retryMaxMs: 2,
        handle: async (attempts) => {
          if (failures < 30) {
            failures++;
            throw new Error('database unavailable');
          }
          received.push(await handleBatch(pool, SALE, attempts));
        },
        onError: () => {},
      });

      const users = ['a1', 'a2', 'a3', 'a4', 'a5'];
      for (const user of users) await publishAttempt(channel, queue, attempt(user));
      await until(() => received.flatMap((m) => m.results).length === users.length, 10_000);
      await consumer.stop();

      const outcomes = received.flatMap((m) => m.results.map((r) => [r.userId, r.status]));
      expect(outcomes.sort()).toEqual(users.map((u) => [u, 'confirmed']));
      expect(handBack).not.toHaveBeenCalled();
      expect(await depth(queue)).toBe(0);
      expect(await depth(deadLetterQueue)).toBe(0);
    });

    it('claims a failed batch before the attempts that arrived after it', async () => {
      // A returned message goes back to the front of the queue, but the broker
      // does not recall what it has already prefetched to the worker: handing
      // a failed batch back let the next one, already delivered, be claimed
      // first. Held and retried, the failed batch keeps its place.
      for (const user of ['u1', 'u2', 'u3', 'u4'])
        await publishAttempt(channel, queue, attempt(user));
      let failures = 0;
      const claimed: string[][] = [];
      const consumer = await startBatchConsumer({
        channel,
        queue,
        batchMax: 2,
        flushMs: 5,
        retryMinMs: 1,
        retryMaxMs: 2,
        handle: async (attempts) => {
          // Only the first batch fails, so the second would succeed at once.
          if (attempts[0]!.userId === 'u1' && failures < 3) {
            failures++;
            throw new Error('database unavailable');
          }
          claimed.push(attempts.map((a) => a.userId));
        },
        onError: () => {},
      });

      await until(() => claimed.flat().length === 4);
      await consumer.stop();

      expect(claimed).toEqual([
        ['u1', 'u2'],
        ['u3', 'u4'],
      ]);
    });

    it('hands a failing batch back when stopped, so a later ack cannot swallow it', async () => {
      // Stopped mid-outage, with the database back just as the next batch
      // runs: that batch's ack covers every delivery up to its own, so the one
      // abandoned before it must already be settled — returned, not dropped.
      for (const user of ['u1', 'u2', 'u3', 'u4']) {
        await publishAttempt(channel, queue, attempt(user));
      }
      let recovered = false;
      let failures = 0;
      const claimed: string[][] = [];
      const consumer = await startBatchConsumer({
        channel,
        queue,
        batchMax: 2,
        flushMs: 5,
        retryMinMs: 1,
        retryMaxMs: 2,
        handle: async (attempts) => {
          if (!recovered) {
            failures++;
            throw new Error('database unavailable');
          }
          claimed.push(attempts.map((a) => a.userId));
        },
        onError: () => {},
      });

      await until(() => failures >= 2);
      recovered = true;
      await consumer.stop();

      expect(claimed).toEqual([['u3', 'u4']]);
      await untilDepth(queue, 2);
    });

    it('dead-letters a message past the delivery limit instead of dropping it', async () => {
      // A worker dying while it holds the message, 21 times: a failed delivery
      // counts against the limit on 4.2 and 4.4 alike, where an explicit
      // requeue only counts on 4.2. Past the limit it must land somewhere.
      await publishAttempt(channel, queue, attempt('doomed'));
      for (let death = 0; death <= 20; death++) {
        const worker = await connection.createChannel();
        await new Promise<void>((resolve) => {
          void worker.consume(queue, (message) => {
            if (message) resolve();
          });
        });
        await worker.close();
      }

      await untilDepth(deadLetterQueue, 1);
      expect(await depth(queue)).toBe(0);
    });

    it('dead-letters a malformed message rather than retrying it forever', async () => {
      const consumer = await startBatchConsumer({
        channel,
        queue,
        flushMs: 5,
        handle: async () => {},
        onError: () => {},
      });
      channel.sendToQueue(queue, Buffer.from(JSON.stringify({ userId: 'no-attempt-id' })));
      await channel.waitForConfirms();

      await untilDepth(deadLetterQueue, 1);
      await consumer.stop();
    });
  });

  describe('upgrading a queue declared by an earlier version', () => {
    // The arguments before dead-lettering: RabbitMQ refuses to redeclare over them.
    const previousArgs = {
      'x-queue-type': 'quorum',
      'x-single-active-consumer': true,
      'x-max-length': 100_000,
      'x-overflow': 'reject-publish',
    };
    let old: string;

    beforeEach(async () => {
      old = `test.upgrade.${randomUUID()}`;
      await channel.assertQueue(old, { durable: true, arguments: previousArgs });
    });

    afterEach(async () => {
      await channel.deleteQueue(old).catch(() => {});
      await channel.deleteQueue(`${old}.dead`).catch(() => {});
    });

    it('replaces it when it is empty', async () => {
      const declared = await declareTopology(connection, { queue: old, exchange });

      expect(declared.deadLetterQueue).toBe(`${old}.dead`);
      // Redeclaring with today's arguments now succeeds, which it only can if
      // the queue was replaced.
      await expect(declareTopology(connection, { queue: old, exchange })).resolves.toMatchObject({
        queue: old,
      });
    });

    it('leaves it alone, and refuses to start, while it still holds attempts', async () => {
      channel.sendToQueue(old, Buffer.from(JSON.stringify(attempt('waiting'))));
      await channel.waitForConfirms();

      await expect(declareTopology(connection, { queue: old, exchange })).rejects.toThrow(
        /is not empty/,
      );
      const check = await connection.createChannel();
      expect((await check.checkQueue(old)).messageCount).toBe(1);
      await check.close();
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
