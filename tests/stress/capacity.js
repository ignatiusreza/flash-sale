import exec from 'k6/execution';

import { addressFor, postAttempt, recordAttempt } from './lib/buyer.js';
import { rampThenHold } from './lib/plan.js';
import { BASES, HOLD_S, RATE } from './lib/settings.js';

/**
 * How many attempts per second the stack accepts, through the queue: a stock
 * large enough never to sell out, HTTP only, at a rising arrival rate. Where
 * k6 starts dropping iterations, or 503s appear, is the ceiling. Exploratory —
 * the pass/fail scenarios are `sale`, `load` and `shedding`.
 */
export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 1_000,
      timeUnit: '1s',
      // A longer ramp than the others, to the highest rate, then held:
      // sustained is the claim, not a momentary peak.
      stages: rampThenHold(RATE, HOLD_S, 10),
      preAllocatedVUs: 2_000,
      maxVUs: 5_000,
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const n = exec.scenario.iterationInTest;
  recordAttempt(postAttempt(BASES[n % BASES.length], `cap-${n}`, addressFor(n)));
}

export function handleSummary(data) {
  return { '/out/summary.json': JSON.stringify(data) };
}
