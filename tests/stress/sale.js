import exec from 'k6/execution';

import { addressFor, buy, postAttempt, recordAttempt } from './lib/buyer.js';

/**
 * An oversubscribed sale, in two phases, with a third riding the second
 * (docs/PLAN.md §2.3, §11):
 *
 * - `steady`: buyers at a moderate rate, each connected over the socket, timed
 *   from POST to result — the end-to-end wait when nothing else is queued.
 *   Target: p99 under 100 ms.
 * - `rush`: the opening-second stampede, HTTP only, held at the target rate
 *   well past sellout. Most of it is turned away at the API from cache once
 *   stock is gone; the queue only sees what arrives before. A quarter of it is
 *   a buyer trying again, so the one-per-buyer path runs under load. Target:
 *   the rate held with nothing dropped and nothing failed.
 * - `probe`: socket-connected buyers at a modest rate *during* the rush, timed
 *   the same way as `steady` — the wait while the queue is under the rush,
 *   which `steady` alone never measures, since it ends before the rush starts.
 *
 * The invariants are checked by the orchestrator afterwards, in Postgres and
 * against every result the worker published, since no API exposes them.
 */
const BASES = __ENV.BASE_URLS.split(',');
const STEADY_RATE = Number(__ENV.STEADY_RATE || 300);
const RUSH_RATE = Number(__ENV.RUSH_RATE || 10_000);
const RUSH_HOLD_S = Number(__ENV.RUSH_HOLD_S || 20);
const PROBE_RATE = Number(__ENV.PROBE_RATE || 200);
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
    probe: {
      executor: 'constant-arrival-rate',
      exec: 'probe',
      startTime: '25s',
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: `${5 + RUSH_HOLD_S}s`,
      preAllocatedVUs: 100,
      maxVUs: 1_000,
    },
  },
  thresholds: {
    'result_latency{scenario:steady}': ['p(99)<100'],
    // Reported, not gated: the rush is the laptop's whole capacity, and this
    // says what a buyer waits while it runs — whatever that turns out to be.
    'result_latency{scenario:probe}': ['p(99)>=0'],
    'dropped_iterations{scenario:rush}': [`count<${Math.ceil(RUSH_PLANNED * 0.01)}`],
    'dropped_iterations{scenario:steady}': ['count==0'],
    attempts_failed: ['count==0'],
    results_missing: ['count==0'],
    // Declared so the summary carries each phase on its own.
    'http_reqs{scenario:rush}': ['count>0'],
    'http_reqs{scenario:steady}': ['count>0'],
    'http_reqs{scenario:probe}': ['count>0'],
    'http_req_duration{scenario:rush}': ['p(99)>=0'],
    'http_req_duration{scenario:steady}': ['p(99)>=0'],
    'http_req_duration{scenario:probe}': ['p(99)>=0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const OFFSETS = { steady: 0, rush: 1 << 22, probe: 2 << 22 };

/** Distinct per iteration across all phases: no address or name shared between them. */
function buyerNumber() {
  return OFFSETS[exec.scenario.name] + exec.scenario.iterationInTest;
}

/** One socket-connected buyer, timed from POST to result. */
function connectedBuyer(prefix) {
  const n = buyerNumber();
  buy({
    // Socket on one instance, POST to the other: the result has to cross.
    wsUrl: BASES[n % BASES.length].replace(/^http/, 'ws'),
    apiUrl: BASES[(n + 1) % BASES.length],
    userId: `${prefix}-${n}`,
    ip: addressFor(n),
  });
}

export function steady() {
  connectedBuyer('steady');
}

export function rush() {
  const n = buyerNumber();
  // Every fourth attempt is the previous buyer again, on another instance.
  const buyer = n % 4 === 3 ? n - 1 : n;
  recordAttempt(postAttempt(BASES[n % BASES.length], `rush-${buyer}`, addressFor(n)));
}

export function probe() {
  connectedBuyer('probe');
}

export function handleSummary(data) {
  return { '/out/summary.json': JSON.stringify(data) };
}
