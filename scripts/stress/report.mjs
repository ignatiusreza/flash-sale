import { count } from './wait.mjs';

/** Phases a scenario may run, in the order they are reported. */
const PHASES = ['steady', 'rush', 'claims', 'probe'];

/**
 * Prints what happened, then every verdict. Latency is per phase, never
 * pooled: a quiet phase's p99 is not the rush's, and an average across a gap
 * means nothing. Each result percentile comes with how many results it timed.
 */
export function report(say, summary, verdicts) {
  const m = summary.metrics;
  const n = (metric) => count(summary, metric);
  const ms = (metric, stat) => m[metric]?.values?.[stat]?.toFixed(1) ?? '–';
  const latency = (metric) =>
    `p50 ${ms(metric, 'p(50)')} ms  p95 ${ms(metric, 'p(95)')} ms  p99 ${ms(metric, 'p(99)')} ms`;

  say('');
  say(
    `attempts  accepted ${n('attempts_accepted')}  refused ${n('attempts_refused')}  limited ${n('attempts_limited')}  shed ${n('attempts_shed')}  failed ${n('attempts_failed')}`,
  );
  say(
    `results   confirmed ${n('results_confirmed')}  sold out ${n('results_sold_out')}  other ${n('results_other')}  missing ${n('results_missing')}`,
  );
  say(`requests  ${n('http_reqs')}  dropped iterations ${n('dropped_iterations')}`);

  for (const phase of PHASES) {
    const sent = n(`http_reqs{scenario:${phase}}`);
    if (sent === 0) continue;
    say(`${phase.padEnd(7)}   ${sent} requests`);
    if (m[`http_req_duration{scenario:${phase}}`]) {
      say(`  POST    ${latency(`http_req_duration{scenario:${phase}}`)}`);
    }
    if (m[`result_latency{scenario:${phase}}`]) {
      const timed = n(`results_timed{scenario:${phase}}`);
      say(`  result  ${latency(`result_latency{scenario:${phase}}`)}  (${timed} timed)`);
    }
  }

  say('');
  for (const verdict of verdicts) say(`${verdict.pass ? 'PASS' : 'FAIL'}  ${verdict.name}`);
}
