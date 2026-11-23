import exec from 'k6/execution';

import { addressFor, buy, postAttempt, recordAttempt } from './lib/buyer.js';
import { plannedAttempts, rampThenHold } from './lib/plan.js';
import { BASES, HOLD_S, PROBE_RATE, RATE } from './lib/settings.js';

/**
 * An oversubscribed sale, in two phases (docs/PLAN.md §2.3, §11):
 *
 * - `steady`: buyers on the socket at `PROBE_RATE`, timed from POST to
 *   result — the end-to-end wait when nothing else is queued. Target: p99
 *   under 100 ms.
 * - `rush`: the opening-second stampede, HTTP only, ramped to `RATE` and held
 *   for `HOLD_S`, well past sellout. Most of it is turned away at the API from cache once
 *   stock is gone; the queue only sees what arrives before. A quarter of it is
 *   a buyer trying again, so the one-per-buyer path runs under load. Target:
 *   the rate held with nothing dropped and nothing failed.
 *
 * What a buyer waits while the queue is genuinely busy is `load`'s question,
 * not this one's: this rush sells out within seconds, after which almost every
 * attempt is refused from memory.
 *
 * The invariants are checked by the orchestrator afterwards, in Postgres and
 * against every result the worker published, since no API exposes them.
 */
// Held means at most 1% of the rush was dropped for want of capacity.
const RUSH_PLANNED = plannedAttempts(RATE, HOLD_S);

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      exec: 'steady',
      rate: PROBE_RATE,
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
      stages: rampThenHold(RATE, HOLD_S),
      preAllocatedVUs: 2_000,
      maxVUs: 5_000,
    },
  },
  thresholds: {
    'result_latency{scenario:steady}': ['p(99)<100'],
    'results_timed{scenario:steady}': ['count>0'],
    'dropped_iterations{scenario:rush}': [`count<${Math.ceil(RUSH_PLANNED * 0.01)}`],
    'dropped_iterations{scenario:steady}': ['count==0'],
    attempts_failed: ['count==0'],
    results_missing: ['count==0'],
    // Declared so the summary carries each phase on its own.
    'http_reqs{scenario:rush}': ['count>0'],
    'http_reqs{scenario:steady}': ['count>0'],
    'http_req_duration{scenario:rush}': ['p(99)>=0'],
    'http_req_duration{scenario:steady}': ['p(99)>=0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const OFFSETS = { steady: 0, rush: 1 << 22 };

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

export function handleSummary(data) {
  return { '/out/summary.json': JSON.stringify(data) };
}
