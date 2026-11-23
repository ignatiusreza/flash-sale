import exec from 'k6/execution';

import { addressFor, buy, postAttempt, recordAttempt } from './lib/buyer.js';
import { RAMP_S, rampThenHold } from './lib/plan.js';
import { BASES, HOLD_S, PROBE_RATE, RATE } from './lib/settings.js';

/**
 * What a buyer waits while the system is genuinely busy (issue #17).
 *
 * `sale` cannot say: its rush sells out within seconds, after which almost
 * every attempt is refused from memory, so the queue and the claim are barely
 * working while it is "held". Here the stock never sells out, so every
 * attempt is a real claim through the queue:
 *
 * - `claims`: HTTP attempts ramped to the target rate and held there, every
 *   one a distinct buyer.
 * - `probe`: buyers on the socket, timed from POST to result, throughout the
 *   hold — the wait while the worker is claiming at that rate.
 */
export const options = {
  scenarios: {
    claims: {
      executor: 'ramping-arrival-rate',
      exec: 'claims',
      startRate: 1_000,
      timeUnit: '1s',
      stages: rampThenHold(RATE, HOLD_S),
      preAllocatedVUs: 2_000,
      maxVUs: 5_000,
    },
    probe: {
      executor: 'constant-arrival-rate',
      exec: 'probe',
      startTime: `${RAMP_S}s`,
      rate: PROBE_RATE,
      timeUnit: '1s',
      duration: `${HOLD_S}s`,
      preAllocatedVUs: 100,
      maxVUs: 1_000,
    },
  },
  thresholds: {
    'result_latency{scenario:probe}': ['p(99)<100'],
    // Enough samples for the p99 to mean something.
    'results_timed{scenario:probe}': [`count>=${Math.floor(PROBE_RATE * HOLD_S * 0.9)}`],
    attempts_failed: ['count==0'],
    results_missing: ['count==0'],
    // Declared so the summary carries each phase on its own.
    'http_reqs{scenario:claims}': ['count>0'],
    'http_reqs{scenario:probe}': ['count>0'],
    'http_req_duration{scenario:claims}': ['p(99)>=0'],
    'http_req_duration{scenario:probe}': ['p(99)>=0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const OFFSETS = { claims: 0, probe: 1 << 22 };

function buyerNumber() {
  return OFFSETS[exec.scenario.name] + exec.scenario.iterationInTest;
}

export function claims() {
  const n = buyerNumber();
  recordAttempt(postAttempt(BASES[n % BASES.length], `load-${n}`, addressFor(n)));
}

export function probe() {
  const n = buyerNumber();
  buy({
    // Socket on one instance, POST to the other: the result has to cross.
    wsUrl: BASES[n % BASES.length].replace(/^http/, 'ws'),
    apiUrl: BASES[(n + 1) % BASES.length],
    userId: `probe-${n}`,
    ip: addressFor(n),
  });
}

export function handleSummary(data) {
  return { '/out/summary.json': JSON.stringify(data) };
}
