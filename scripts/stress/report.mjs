import { count } from './wait.mjs';

/** The order phases run in, where a scenario has them; any other comes last. */
const PHASE_ORDER = ['steady', 'rush', 'claims', 'probe'];

/**
 * Prints what happened, what was measured, then every verdict.
 *
 * Two different counts of outcomes appear, and are labelled as such: the
 * `POST` answers every attempt got from the API, and the results the
 * socket-connected buyers heard back — only those buyers listen, so in `sale`
 * it is the quiet phase's few thousand, not the units sold. Every result the
 * worker announced is checked separately, in the verdicts.
 *
 * Latency is per phase, never pooled: a quiet phase's p99 is not the rush's,
 * and an average across a gap means nothing.
 */
export function report(say, summary, { notes, verdicts }) {
  // Between groups, a rule in the same gutter as every other line.
  const fence = () => say('─'.repeat(72));
  const m = summary.metrics;
  const n = (metric) => count(summary, metric);
  const ms = (metric, stat) => m[metric]?.values?.[stat]?.toFixed(1) ?? '–';
  const latency = (metric) =>
    `p50 ${ms(metric, 'p(50)')} ms  p95 ${ms(metric, 'p(95)')} ms  p99 ${ms(metric, 'p(99)')} ms`;

  fence();
  // Each answer its own line: they are different reports, not one total.
  const rows = (title, total, items) => {
    say(`${title.padEnd(18)}${String(total).padStart(8)}`);
    for (const [label, value] of items) {
      say(`  ${label.padEnd(16)}${String(value).padStart(8)}`);
    }
  };

  rows('POST answers', n('http_reqs'), [
    ['202 queued', n('attempts_accepted')],
    ['409 refused', n('attempts_refused')],
    ['429 limited', n('attempts_limited')],
    ['503 shed', n('attempts_shed')],
    ['failed', n('attempts_failed')],
  ]);
  const skipped = n('dropped_iterations');
  if (skipped > 0) say(`  (k6 fell behind and never sent ${skipped} more it had planned)`);

  const timed = n('results_timed');
  if (timed > 0 || n('results_missing') > 0) {
    fence();
    rows('socket buyers', timed, [
      ['confirmed', n('results_confirmed')],
      ['sold out', n('results_sold_out')],
      ['other', n('results_other')],
      ['never heard back', n('results_missing')],
    ]);
    say('  (only buyers on a socket hear a result; HTTP-only attempts are not counted here)');
  }

  // The phases are the k6 scenarios that reported their own requests.
  const rank = (phase) =>
    PHASE_ORDER.includes(phase) ? PHASE_ORDER.indexOf(phase) : PHASE_ORDER.length;
  const phases = Object.keys(m)
    .map((metric) => /^http_reqs\{scenario:(.+)\}$/.exec(metric)?.[1])
    .filter(Boolean)
    .sort((a, b) => rank(a) - rank(b));
  if (phases.length === 0) {
    say(`all requests   POST answered  ${latency('http_req_duration')}`);
  }
  for (const phase of phases) {
    fence();
    say(`${phase} — ${n(`http_reqs{scenario:${phase}}`)} requests`);
    if (m[`http_req_duration{scenario:${phase}}`]) {
      say(`  POST answered  ${latency(`http_req_duration{scenario:${phase}}`)}`);
    }
    if (m[`result_latency{scenario:${phase}}`]) {
      say(
        `  result heard   ${latency(`result_latency{scenario:${phase}}`)}  ` +
          `(${n(`results_timed{scenario:${phase}}`)} timed)`,
      );
    }
  }

  if (notes.length > 0) {
    fence();
    for (const note of notes) say(note);
  }

  fence();
  for (const verdict of verdicts) say(`${verdict.pass ? 'PASS' : 'FAIL'}  ${verdict.name}`);
}
