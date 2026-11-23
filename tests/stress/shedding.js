import exec from 'k6/execution';

import { addressFor, postAttempt, recordAttempt } from './lib/buyer.js';
import { BASES, HOLD_S, RATE } from './lib/settings.js';

/**
 * Past the queue bound (docs/PLAN.md §11): with the worker stopped, attempts
 * arrive faster than anything leaves, the queue fills to its bound, and every
 * attempt after that must be shed with a clean 503 — not queued without limit,
 * not failed. `RATE` arrives for `HOLD_S`, with no ramp. The orchestrator
 * then starts the worker and checks that every accepted attempt is still there
 * and becomes an order.
 */
export const options = {
  scenarios: {
    flood: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${HOLD_S}s`,
      preAllocatedVUs: 200,
      maxVUs: 2_000,
    },
  },
  thresholds: {
    // Shedding means answering; a timeout or a 500 is not shedding.
    attempts_failed: ['count==0'],
    http_req_failed: ['rate==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const n = exec.scenario.iterationInTest;
  recordAttempt(postAttempt(BASES[n % BASES.length], `shed-${n}`, addressFor(n)));
}

export function handleSummary(data) {
  return { '/out/summary.json': JSON.stringify(data) };
}
