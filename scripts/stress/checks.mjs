import { plannedAttempts } from '../../tests/stress/lib/plan.js';
import { count, until } from './wait.mjs';

/**
 * Each scenario's verdicts, from the k6 summary and the stack's own view of
 * the database and of every announced result. Called with
 * `{ scenario, summary, stack, apiMemoryBefore, say }`.
 */

/** Waits for every accepted attempt's result, which follows its commit by a moment. */
async function untilAnswered(stack, accepted) {
  await stack.untilQueueEmpty();
  await until(async () => stack.results.length >= accepted, 10_000).catch(() => {});
}

function rateHeld(label, sent, { rate, holdS }) {
  const planned = plannedAttempts(rate, holdS);
  return {
    name: `${label} held ${rate}/s for ${holdS} s (${sent} of ${Math.round(planned)} sent)`,
    pass: sent >= planned * 0.99,
  };
}

/**
 * The oversubscribed sale: stock sold exactly, and every result the worker
 * announced held against the orders in Postgres — not merely counted.
 */
export async function checkSale({ scenario, summary, stack, say }) {
  const accepted = count(summary, 'attempts_accepted');
  await untilAnswered(stack, accepted);
  const { results } = stack;
  const { orders, remaining } = await stack.ledger();
  const held = await stack.heldOrders();

  // Every attempt lands in exactly one of these.
  const offered = ['accepted', 'refused', 'limited', 'shed', 'failed']
    .map((outcome) => count(summary, `attempts_${outcome}`))
    .reduce((sum, n) => sum + n, 0);
  say(
    `oversubscription: ${(offered / scenario.stock).toFixed(1)}× stock offered, ` +
      `${(accepted / scenario.stock).toFixed(2)}× reached the queue (the rest refused from cache)`,
  );

  const answered = new Set(results.map((result) => result.attemptId));
  // Distinct pairs: a buyer's repeats in one batch are each told `confirmed`,
  // with the one order they share.
  const confirmed = new Set(
    results.filter((r) => r.status === 'confirmed').map((r) => `${r.userId}:${r.orderId}`),
  );
  const ordersSet = new Set([...held].map(([userId, orderId]) => `${userId}:${orderId}`));
  const sameSet =
    confirmed.size === ordersSet.size && [...confirmed].every((pair) => ordersSet.has(pair));
  // A holder must only ever hear of their own order; anyone else, sold out.
  const wrong = results.filter((result) => {
    const orderId = held.get(result.userId);
    return orderId
      ? !['confirmed', 'already_purchased'].includes(result.status) || result.orderId !== orderId
      : result.status !== 'sold_out';
  }).length;

  return [
    rateHeld('rush', count(summary, 'http_reqs{scenario:rush}'), scenario),
    { name: `orders = stock (${orders} of ${scenario.stock})`, pass: orders === scenario.stock },
    { name: `remaining = 0 (${remaining})`, pass: remaining === 0 },
    {
      name: `every accepted attempt answered exactly once (${answered.size} of ${accepted}, ${results.length} results)`,
      pass: answered.size === accepted && results.length === accepted,
    },
    {
      name: `confirmed = orders, the same set (${confirmed.size} confirmed, ${ordersSet.size} orders)`,
      pass: sameSet,
    },
    { name: `no buyer told anything but their own outcome (${wrong} wrong)`, pass: wrong === 0 },
  ];
}

/**
 * Every attempt a real claim: the rate held, each accepted attempt an order,
 * and each answered exactly once — the wait is only worth reporting if the
 * system was doing the work it stands for.
 */
export async function checkLoad({ scenario, summary, stack }) {
  const accepted = count(summary, 'attempts_accepted');
  await untilAnswered(stack, accepted);
  const { results } = stack;
  const { orders } = await stack.ledger();
  const answered = new Set(results.map((result) => result.attemptId));
  const confirmed = results.filter((result) => result.status === 'confirmed').length;

  return [
    rateHeld('claims', count(summary, 'http_reqs{scenario:claims}'), scenario),
    {
      name: `every accepted attempt claimed (${orders} orders for ${accepted} accepted)`,
      pass: orders === accepted,
    },
    {
      name: `every accepted attempt answered exactly once, and confirmed (${answered.size} answered, ${confirmed} confirmed)`,
      pass: answered.size === accepted && results.length === accepted && confirmed === accepted,
    },
  ];
}

/**
 * Past the bound: the overflow is shed with 503, the API's memory does not
 * grow with it, and every attempt that was accepted is still there — the
 * stock is large, so each accepted attempt must become exactly one order.
 */
export async function checkShedding({ scenario, summary, stack, apiMemoryBefore, say }) {
  const accepted = count(summary, 'attempts_accepted');
  const shed = count(summary, 'attempts_shed');
  const apiMemoryAfter = stack.apiMemory();

  say(`starting the worker to drain ${accepted} accepted attempts…`);
  const drainStarted = Date.now();
  stack.startWorker();
  await until(async () => (await stack.ledger()).orders >= accepted, 120_000);
  const drainSeconds = (Date.now() - drainStarted) / 1000;
  await stack.untilQueueEmpty();
  const { orders } = await stack.ledger();
  // Includes the worker's own start-up, so it understates the claim rate.
  say(
    `drained ${orders} in ${drainSeconds.toFixed(1)} s — ${(orders / drainSeconds).toFixed(0)} claims/s`,
  );

  const growthMb = Math.max(
    ...apiMemoryAfter.map((after, i) => (after - apiMemoryBefore[i]) / 1024),
  );
  return [
    { name: `overflow shed with 503 (${shed})`, pass: shed > 0 },
    {
      // Not exact: with two instances publishing at once, measured at 50 over
      // a 50 000 bound. The point is that it stops growing, not the last unit.
      name: `queue held its bound (${accepted} accepted for ${scenario.queueMax}, within 1%)`,
      pass: accepted <= scenario.queueMax * 1.01,
    },
    {
      name: `nothing accepted was lost (${orders} orders for ${accepted} accepted)`,
      pass: orders === accepted,
    },
    { name: `API memory flat (+${growthMb.toFixed(0)} MB)`, pass: growthMb < 100 },
  ];
}
