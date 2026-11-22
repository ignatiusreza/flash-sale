import exec from 'k6/execution';

import { addressFor, postAttempt, recordAttempt } from './lib/buyer.js';

/**
 * How many attempts per second the stack accepts, through the queue: a stock
 * large enough never to sell out, HTTP only, at a rising arrival rate. Where
 * k6 starts dropping iterations, or 503s appear, is the ceiling. Exploratory —
 * the pass/fail scenarios are `sale` and `shedding`.
 */
const BASES = __ENV.BASE_URLS.split(',');
const PEAK = Number(__ENV.PEAK_RATE || 20_000);

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 1_000,
      timeUnit: '1s',
      // A short ramp, then held: sustained is the claim, not a momentary peak.
      stages: [
        { target: PEAK, duration: '10s' },
        { target: PEAK, duration: '30s' },
      ],
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
