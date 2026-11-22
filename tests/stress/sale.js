import exec from 'k6/execution';

import { addressFor, buy, postAttempt, recordAttempt } from './lib/buyer.js';

/**
 * An oversubscribed sale, in two phases (docs/PLAN.md §2.3, §11):
 *
 * - `steady`: buyers at a moderate rate, each connected over the socket, timed
 *   from POST to result — the end-to-end wait for attempts that are not queued
 *   behind a burst. Target: p99 under 100 ms.
 * - `rush`: the opening-second stampede, HTTP only, held at the target rate
 *   well past sellout. Most of it is turned away at the API from cache once
 *   stock is gone; the queue only sees what arrives before. Target: the rate
 *   held with nothing dropped and nothing failed.
 *
 * The invariants — orders equal stock, one per buyer — are checked in Postgres
 * by the orchestrator afterwards, since no API exposes them.
 */
const BASES = __ENV.BASE_URLS.split(',');
const STEADY_RATE = Number(__ENV.STEADY_RATE || 300);
const RUSH_RATE = Number(__ENV.RUSH_RATE || 10_000);
const RUSH_HOLD_S = Number(__ENV.RUSH_HOLD_S || 20);
// The rush ramps from 1 000/s over 5 s, then holds. Held means at most 1% of
// these were dropped for want of capacity — on a laptop shared with
// everything else, a handful always are, and zero would test the laptop.
const RUSH_PLANNED = (5 * (1_000 + RUSH_RATE)) / 2 + RUSH_RATE * RUSH_HOLD_S;

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      exec: 'steady',
      rate: STEADY_RATE,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 100,
      maxVUs: 1_000,
    },
    rush: {
      executor: 'ramping-arrival-rate',
      exec: 'rush',
      startTime: '25s',
      startRate: 1_000,
      timeUnit: '1s',
      stages: [
        { target: RUSH_RATE, duration: '5s' },
        { target: RUSH_RATE, duration: `${RUSH_HOLD_S}s` },
      ],
      preAllocatedVUs: 2_000,
      maxVUs: 5_000,
    },
  },
  thresholds: {
    'result_latency{scenario:steady}': ['p(99)<100'],
    'dropped_iterations{scenario:rush}': [`count<${Math.ceil(RUSH_PLANNED * 0.01)}`],
    'dropped_iterations{scenario:steady}': ['count==0'],
    attempts_failed: ['count==0'],
    results_missing: ['count==0'],
    // Declared so the summary carries the per-phase request counts.
    'http_reqs{scenario:rush}': ['count>0'],
    'http_reqs{scenario:steady}': ['count>0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

/** Distinct per buyer across both phases: no buyer, address or name reused. */
function buyerNumber() {
  const offset = exec.scenario.name === 'rush' ? 1 << 22 : 0;
  return offset + exec.scenario.iterationInTest;
}

export function steady() {
  const n = buyerNumber();
  buy({
    // Socket on one instance, POST to the other: the result has to cross.
    wsUrl: BASES[n % BASES.length].replace(/^http/, 'ws'),
    apiUrl: BASES[(n + 1) % BASES.length],
    userId: `steady-${n}`,
    ip: addressFor(n),
  });
}

export function rush() {
  const n = buyerNumber();
  recordAttempt(postAttempt(BASES[n % BASES.length], `rush-${n}`, addressFor(n)));
}

export function handleSummary(data) {
  return { '/out/summary.json': JSON.stringify(data) };
}
