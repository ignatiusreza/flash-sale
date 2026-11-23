import { plannedAttempts } from '../../tests/stress/lib/plan.js';
import { count, until } from './wait.mjs';

/**
 * Each scenario's check, from the k6 summary and the stack's own view of the
 * database and of every announced result. Called with
 * `{ scenario, summary, stack, apiMemoryBefore, say }`, it resolves
 * `{ verdicts, notes }`: named pass/fail lines, and measured facts worth
 * printing beside them.
 *
 * "Queued" is an attempt the API answered 202, which the worker must claim.
 */

/**
 * k6's own thresholds, as verdicts: every one that failed by name, and the
 * rest as one line. Some exist only so the summary carries each phase.
 */
export function thresholdVerdicts(summary) {
  const all = Object.entries(summary.metrics).flatMap(([metric, { thresholds = {} }]) =>
    Object.entries(thresholds).map(([rule, { ok }]) => ({ name: `${metric} ${rule}`, ok })),
  );
  if (all.length === 0) return [];
  const failed = all.filter((threshold) => !threshold.ok);
  return [
    {
      name: `k6 thresholds (${all.length - failed.length} of ${all.length} met)`,
      pass: failed.length === 0,
    },
    ...failed.map((threshold) => ({ name: `  ${threshold.name}`, pass: false })),
  ];
}

/** Waits for every queued attempt's result, which follows its commit by a moment. */
async function untilAnswered(stack, queued) {
  await stack.untilQueueEmpty();
  await until(async () => stack.results.length >= queued, 10_000).catch(() => {});
}

function rateHeld(label, sent, { rate, holdS }) {
  const planned = plannedAttempts(rate, holdS);
  return {
    name: `${label} held ${rate}/s for ${holdS} s (${sent} of ${Math.round(planned)} attempts sent)`,
    pass: sent >= planned * 0.99,
  };
}

/**
 * The oversubscribed sale: stock sold exactly, and every result the worker
 * announced held against the orders in Postgres — not merely counted.
 */
export async function checkSale({ scenario, summary, stack }) {
  const queued = count(summary, 'attempts_accepted');
  await untilAnswered(stack, queued);
  const { results } = stack;
  const { orders, remaining } = await stack.ledger();
  const held = await stack.heldOrders();

  // Every attempt lands in exactly one of these.
  const offered = ['accepted', 'refused', 'limited', 'shed', 'failed']
    .map((outcome) => count(summary, `attempts_${outcome}`))
    .reduce((sum, n) => sum + n, 0);

  const answered = new Set(results.map((result) => result.attemptId));
  // Distinct pairs: a buyer's repeats in one batch are each told `confirmed`,
  // with the one order they share.
  const confirmations = new Set(
    results.filter((r) => r.status === 'confirmed').map((r) => `${r.userId}:${r.orderId}`),
  );
  const orderPairs = new Set([...held].map(([userId, orderId]) => `${userId}:${orderId}`));
  const sameSet =
    confirmations.size === orderPairs.size &&
    [...confirmations].every((pair) => orderPairs.has(pair));
  // A holder must only ever hear of their own order; anyone else, sold out.
  const wrong = results.filter((result) => {
    const orderId = held.get(result.userId);
    return orderId
      ? !['confirmed', 'already_purchased'].includes(result.status) || result.orderId !== orderId
      : result.status !== 'sold_out';
  }).length;

  return {
    notes: [
      `${scenario.stock} units; ${offered} attempts offered (${(offered / scenario.stock).toFixed(1)}× stock), ` +
        `${queued} queued (${(queued / scenario.stock).toFixed(2)}×) — the rest refused from cache once sold out`,
      `the worker announced ${results.length} results — for every queued attempt, the rush's too — all checked against Postgres below`,
    ],
    verdicts: [
      rateHeld('rush', count(summary, 'http_reqs{scenario:rush}'), scenario),
      {
        name: `sold exactly the stock (${orders} orders for ${scenario.stock} units)`,
        pass: orders === scenario.stock,
      },
      { name: `nothing left unsold (${remaining} remaining)`, pass: remaining === 0 },
      {
        name: `every queued attempt answered exactly once (${answered.size} answered of ${queued} queued, ${results.length} results)`,
        pass: answered.size === queued && results.length === queued,
      },
      {
        name: `every confirmation is an order, and every order was confirmed (${confirmations.size} confirmations, ${orderPairs.size} orders)`,
        pass: sameSet,
      },
      { name: `nobody told the wrong outcome (${wrong} wrong)`, pass: wrong === 0 },
    ],
  };
}

/**
 * Every attempt a real claim: the rate held, each queued attempt an order,
 * and each answered exactly once — the wait is only worth reporting if the
 * system was doing the work it stands for.
 */
export async function checkLoad({ scenario, summary, stack }) {
  const queued = count(summary, 'attempts_accepted');
  await untilAnswered(stack, queued);
  const { results } = stack;
  const { orders } = await stack.ledger();
  const answered = new Set(results.map((result) => result.attemptId));
  const confirmed = results.filter((result) => result.status === 'confirmed').length;

  return {
    notes: [`the worker announced ${results.length} results, all checked against Postgres below`],
    verdicts: [
      rateHeld('claims', count(summary, 'http_reqs{scenario:claims}'), scenario),
      {
        name: `every queued attempt became an order (${orders} orders for ${queued} queued)`,
        pass: orders === queued,
      },
      {
        name: `every queued attempt answered exactly once, as confirmed (${answered.size} answered, ${confirmed} confirmed, of ${queued} queued)`,
        pass: answered.size === queued && results.length === queued && confirmed === queued,
      },
    ],
  };
}

/**
 * Past the bound: the overflow is shed with 503, the API's memory does not
 * grow with it, and every attempt that was queued is still there — the stock
 * is large, so each queued attempt must become exactly one order.
 */
export async function checkShedding({ scenario, summary, stack, apiMemoryBefore, say }) {
  const queued = count(summary, 'attempts_accepted');
  const shed = count(summary, 'attempts_shed');
  const apiMemoryAfter = stack.apiMemory();

  say(`starting the worker to drain ${queued} queued attempts…`);
  const drainStarted = Date.now();
  stack.startWorker();
  await until(async () => (await stack.ledger()).orders >= queued, 120_000);
  const drainSeconds = (Date.now() - drainStarted) / 1000;
  await stack.untilQueueEmpty();
  const { orders } = await stack.ledger();

  const growthMb = Math.max(
    ...apiMemoryAfter.map((after, i) => (after - apiMemoryBefore[i]) / 1024),
  );
  return {
    notes: [
      // Includes the worker's own start-up, so it understates the claim rate.
      `drained ${orders} in ${drainSeconds.toFixed(1)} s (${(orders / drainSeconds).toFixed(0)} claims/s, start-up included)`,
    ],
    verdicts: [
      { name: `overflow shed with 503 (${shed} shed)`, pass: shed > 0 },
      {
        // Not exact: with two instances publishing at once, measured at 50 over
        // a 50 000 bound. The point is that it stops growing, not the last unit.
        name: `queue held its bound (${queued} queued for a bound of ${scenario.queueMax}, within 1%)`,
        pass: queued <= scenario.queueMax * 1.01,
      },
      {
        name: `nothing queued was lost (${orders} orders for ${queued} queued)`,
        pass: orders === queued,
      },
      { name: `API memory flat (+${growthMb.toFixed(0)} MB)`, pass: growthMb < 100 },
    ],
  };
}

/**
 * Exploratory, so no verdicts: how fast attempts became orders, from the
 * orders' own timestamps — the claim rate through the queue, whatever k6 or
 * the API managed in front of it.
 */
export async function checkCapacity({ summary, stack }) {
  const queued = count(summary, 'attempts_accepted');
  await untilAnswered(stack, queued);
  const { orders, seconds } = await stack.claimSpan();
  return {
    notes: [
      `${orders} orders over ${seconds.toFixed(1)} s: ~${seconds > 0 ? Math.round(orders / seconds) : 0} claims/s through the queue, ` +
        'averaged over the ramp as well as the hold, so the held rate was higher',
    ],
    verdicts: [],
  };
}
