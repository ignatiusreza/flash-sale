#!/usr/bin/env node
/**
 * Runs a stress scenario against a stack of its own and checks the result:
 *
 *   pnpm stress sale       # oversubscribed sale: latency, throughput, invariants
 *   pnpm stress load       # a buyer's wait while every attempt is a real claim
 *   pnpm stress shedding   # past the queue bound: clean 503s, nothing lost
 *   pnpm stress capacity   # exploratory: where the ceiling is
 *
 * It is `APP_ENV=stress` — its own database and queues — so it runs beside
 * `pnpm dev` and the E2E suite. Two API instances serve it, and buyers connect
 * their socket to one and POST to the other, so results really do cross
 * instances. k6 drives the load from Docker; the invariants are then checked
 * in Postgres, because a load test that only reports throughput proves nothing
 * (docs/PLAN.md §1, principle 3).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, supervisor } from './lib/stack.mjs';

const K6_IMAGE = 'grafana/k6:2.3.0';
const PORTS = [3200, 3201];
const OUT = path.join(ROOT, 'tests/stress/out');

/**
 * Per scenario: the sale it starts from, the queue bound, whether the worker
 * runs from the start, and the k6 options passed through. `check` turns the
 * k6 summary plus the database into named pass/fail verdicts.
 */
const SCENARIOS = {
  sale: {
    stock: Number(process.env.STRESS_STOCK || 20_000),
    worker: 'from the start',
    rushRate: Number(process.env.STRESS_RUSH_RATE || 10_000),
    rushHoldS: Number(process.env.STRESS_RUSH_HOLD_S || 20),
    get vars() {
      return {
        STEADY_RATE: process.env.STRESS_STEADY_RATE,
        RUSH_RATE: String(this.rushRate),
        RUSH_HOLD_S: String(this.rushHoldS),
      };
    },
    check: checkSale,
  },
  load: {
    stock: 10_000_000,
    worker: 'from the start',
    rate: Number(process.env.STRESS_RATE || 10_000),
    holdS: Number(process.env.STRESS_HOLD_S || 20),
    get vars() {
      return {
        RATE: String(this.rate),
        HOLD_S: String(this.holdS),
        PROBE_RATE: process.env.STRESS_PROBE_RATE,
      };
    },
    check: checkLoad,
  },
  shedding: {
    stock: 1_000_000,
    queueMax: Number(process.env.STRESS_QUEUE_MAX || 2_000),
    worker: 'after the load',
    vars: { RATE: process.env.STRESS_RATE, SECONDS: process.env.STRESS_SECONDS },
    check: checkShedding,
  },
  capacity: {
    stock: 10_000_000,
    worker: 'from the start',
    vars: { PEAK_RATE: process.env.STRESS_PEAK_RATE },
    check: async () => [],
  },
};

const name = process.argv[2] ?? 'sale';
const scenario = SCENARIOS[name];
if (!scenario) {
  console.error(`unknown scenario "${name}": ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const stress = supervisor('stress');
const env = await stress.resolveServices('stress', { readEnvFile: false });
await stress.checkPorts(
  PORTS.map((port, i) => [`API ${i}`, port]),
  'is an earlier stress run still going? Stop it, or free the port, then retry',
);

stress.say('building…');
await stress.run('pnpm', ['-s', 'build']);
await stress.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'create-database'], env);
await stress.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'migrate'], env);

const fromWorker = createRequire(path.join(ROOT, 'apps/worker/package.json'));
const pg = fromWorker('pg');
const amqp = fromWorker('amqplib');
const { subscribeToEvents, topologyNames } = await import(
  pathToFileURL(fromWorker.resolve('@flash-sale/messaging')).href
);
const { queue, exchange } = topologyNames('stress');

// A clean queue: leftovers from an aborted run would be claimed into this
// sale, and a different bound cannot be declared over an existing queue.
const broker = await amqp.connect(env.RABBITMQ_URL);
const channel = await broker.createChannel();
await channel.deleteQueue(queue);

stress.say(`seeding a sale of ${scenario.stock} units…`);
await stress.run('pnpm', ['-s', '--filter', '@flash-sale/worker', 'seed'], {
  ...env,
  SEED_STOCK: String(scenario.stock),
  SEED_DURATION_MINUTES: '60',
  SEED_RESET: '1',
});

const shared = {
  ...env,
  ...(scenario.queueMax ? { QUEUE_MAX_LENGTH: String(scenario.queueMax) } : {}),
};
const sameGroup = { ownGroup: false };
const startWorker = () =>
  stress.start('worker', 'node', ['apps/worker/dist/index.js'], shared, sameGroup);

if (scenario.worker === 'from the start') startWorker();
const apis = PORTS.map((port, i) =>
  stress.start(
    `api${i}`,
    'node',
    ['apps/api/dist/index.js'],
    // k6 stands in for many clients, one address each, through a "proxy".
    { ...shared, PORT: String(port), TRUST_PROXY: 'true' },
    sameGroup,
  ),
);
await Promise.all(PORTS.map((port) => untilOk(`http://localhost:${port}/readyz`)));

const bases = PORTS.map((port) => `http://localhost:${port}`).join(',');
mkdirSync(OUT, { recursive: true });
const rssBefore = apis.map(rssOf);

// Every result the worker announces, heard the way an API instance hears it,
// so the checks can hold each one against Postgres rather than count k6's.
// Results are published unconfirmed — a lost one is recovered by the client's
// order lookup — but nothing here loses them, so each must arrive.
const results = [];
await subscribeToEvents(await broker.createChannel(), exchange, {
  onResults: (message) => results.push(...message.results),
});

stress.say(`running k6 (${name})…`);
const k6Passed = await stress
  .run('docker', [
    'run',
    '--rm',
    '--network=host',
    // As us, so the summary it writes into OUT is ours to read and delete.
    `--user=${process.getuid()}:${process.getgid()}`,
    '-v',
    `${path.join(ROOT, 'tests/stress')}:/scripts:ro`,
    '-v',
    `${OUT}:/out`,
    '-e',
    `BASE_URLS=${bases}`,
    ...Object.entries(scenario.vars)
      .filter(([, value]) => value !== undefined)
      .flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    K6_IMAGE,
    'run',
    '--quiet',
    `/scripts/${name}.js`,
  ])
  .then(
    () => true,
    () => false,
  );

const summary = JSON.parse(readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
const verdicts = [
  { name: 'k6 thresholds', pass: k6Passed },
  ...(await scenario.check({
    summary,
    results,
    rssBefore,
    rssAfter: apis.map(rssOf),
    startWorker,
  })),
];

report(summary, verdicts);
await broker.close().catch(() => {});
await stress.shutdown(verdicts.every((verdict) => verdict.pass) ? 0 : 1);

// ---------------------------------------------------------------------------

/**
 * The oversubscribed sale: stock sold exactly, and every result the worker
 * announced held against the orders in Postgres — not merely counted.
 */
async function checkSale({ summary, results }) {
  await untilQueueEmpty();
  const accepted = count(summary, 'attempts_accepted');
  // The last batch's results follow its commit by a moment.
  await until(async () => results.length >= accepted, 10_000).catch(() => {});
  const { orders, remaining } = await ledger();
  const held = await heldOrders();

  // The rush ramps from 1 000/s to the target over 5 s, then holds it. Every
  // planned attempt sent — k6 drops what it cannot start on time — means the
  // rate was held.
  const { rushRate, rushHoldS } = scenario;
  const planned = (5 * (1_000 + rushRate)) / 2 + rushRate * rushHoldS;
  const sent = count(summary, 'http_reqs{scenario:rush}');
  // Every attempt lands in exactly one of these.
  const offered = ['accepted', 'refused', 'limited', 'shed', 'failed']
    .map((outcome) => count(summary, `attempts_${outcome}`))
    .reduce((sum, n) => sum + n, 0);
  stress.say(
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
    {
      name: `rush held ${rushRate}/s for ${rushHoldS} s (${sent} of ${Math.round(planned)} sent)`,
      pass: sent >= planned * 0.99,
    },
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
async function checkLoad({ summary, results }) {
  await untilQueueEmpty();
  const accepted = count(summary, 'attempts_accepted');
  await until(async () => results.length >= accepted, 10_000).catch(() => {});
  const { orders } = await ledger();

  const { rate, holdS } = scenario;
  const planned = (5 * (1_000 + rate)) / 2 + rate * holdS;
  const sent = count(summary, 'http_reqs{scenario:claims}');
  const answered = new Set(results.map((result) => result.attemptId));
  const confirmed = results.filter((result) => result.status === 'confirmed').length;

  return [
    {
      name: `claims held ${rate}/s for ${holdS} s (${sent} of ${Math.round(planned)} sent)`,
      pass: sent >= planned * 0.99,
    },
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
async function checkShedding({ summary, rssBefore, rssAfter, startWorker }) {
  const accepted = count(summary, 'attempts_accepted');
  const shed = count(summary, 'attempts_shed');

  stress.say(`starting the worker to drain ${accepted} accepted attempts…`);
  const drainStarted = Date.now();
  startWorker();
  await until(async () => (await ledger()).orders >= accepted, 120_000);
  const drainSeconds = (Date.now() - drainStarted) / 1000;
  await untilQueueEmpty();
  const { orders } = await ledger();
  // Includes the worker's own start-up, so it understates the claim rate.
  stress.say(
    `drained ${orders} in ${drainSeconds.toFixed(1)} s — ${(orders / drainSeconds).toFixed(0)} claims/s`,
  );

  const growthMb = Math.max(...rssAfter.map((after, i) => (after - rssBefore[i]) / 1024));
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

/** Each buyer's order, by user id. */
async function heldOrders() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT user_id, id FROM orders WHERE sale_id = 'flash'");
    return new Map(rows.map((row) => [row.user_id, row.id]));
  } finally {
    await client.end();
  }
}

async function ledger() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM orders WHERE sale_id = 'flash') AS orders,
              (SELECT remaining FROM sales WHERE id = 'flash') AS remaining`,
    );
    return rows[0];
  } finally {
    await client.end();
  }
}

/** The worker has taken everything: nothing waiting, nothing unacknowledged. */
async function untilQueueEmpty() {
  await until(async () => {
    const { messageCount } = await channel.checkQueue(queue);
    return messageCount === 0;
  }, 120_000);
  // Unacknowledged deliveries do not count as waiting; give the last batch
  // time to commit before reading the ledger.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`gave up waiting after ${timeoutMs} ms`);
}

async function untilOk(url) {
  await until(async () => (await fetch(url).catch(() => undefined))?.ok === true, 30_000);
}

/** Resident memory of a child process, in kB. */
function rssOf(child) {
  const status = `/proc/${child.pid}/status`;
  if (!existsSync(status)) return 0;
  const match = /VmRSS:\s+(\d+)/.exec(readFileSync(status, 'utf8'));
  return match ? Number(match[1]) : 0;
}

function count(summary, metric) {
  return summary.metrics[metric]?.values?.count ?? 0;
}

function report(summary, verdicts) {
  const m = summary.metrics;
  const n = (metric) => count(summary, metric);
  const ms = (metric, stat) => m[metric]?.values?.[stat]?.toFixed(1) ?? '–';

  stress.say('');
  stress.say(
    `attempts  accepted ${n('attempts_accepted')}  refused ${n('attempts_refused')}  limited ${n('attempts_limited')}  shed ${n('attempts_shed')}  failed ${n('attempts_failed')}`,
  );
  stress.say(
    `results   confirmed ${n('results_confirmed')}  sold out ${n('results_sold_out')}  other ${n('results_other')}  missing ${n('results_missing')}`,
  );
  stress.say(`requests  ${n('http_reqs')}  dropped iterations ${n('dropped_iterations')}`);
  // Per phase where there are phases: an average across a gap means nothing.
  // A quiet phase's p99 is not the rush's, so nothing is pooled across them.
  const latency = (metric) =>
    `p50 ${ms(metric, 'p(50)')} ms  p95 ${ms(metric, 'p(95)')} ms  p99 ${ms(metric, 'p(99)')} ms`;
  for (const phase of ['steady', 'rush', 'claims', 'probe']) {
    const sent = n(`http_reqs{scenario:${phase}}`);
    if (sent === 0) continue;
    stress.say(`${phase.padEnd(7)}   ${sent} requests`);
    if (m[`http_req_duration{scenario:${phase}}`]) {
      stress.say(`  POST    ${latency(`http_req_duration{scenario:${phase}}`)}`);
    }
    if (m[`result_latency{scenario:${phase}}`]) {
      const samples = n(`results_timed{scenario:${phase}}`);
      stress.say(`  result  ${latency(`result_latency{scenario:${phase}}`)}  (${samples} timed)`);
    }
  }
  stress.say('');
  for (const verdict of verdicts) stress.say(`${verdict.pass ? 'PASS' : 'FAIL'}  ${verdict.name}`);
}
