#!/usr/bin/env node
/**
 * Runs a stress scenario against a stack of its own and checks the result:
 *
 *   pnpm stress sale       # oversubscribed sale: latency, throughput, invariants
 *   pnpm stress load       # a buyer's wait while every attempt is a real claim
 *   pnpm stress shedding   # past the queue bound: clean 503s, nothing lost
 *   pnpm stress capacity   # exploratory: where the ceiling is
 *
 * Settings — the same five for every scenario, STRESS_RATE and friends — are
 * in stress/scenarios.mjs. k6 drives the load; the invariants are then checked
 * in Postgres, because a load test that only reports throughput proves nothing
 * (docs/PLAN.md §1, principle 3).
 */
import path from 'node:path';

import { ROOT, supervisor } from './lib/stack.mjs';
import { startStack } from './stress/harness.mjs';
import { runK6 } from './stress/k6.mjs';
import { report } from './stress/report.mjs';
import { scenarioNamed } from './stress/scenarios.mjs';

const scenario = scenarioNamed(process.argv[2] ?? 'sale');
// The stack's own output goes to a file per process, so the terminal carries
// the run and its report and nothing else.
const logDir = path.join(ROOT, 'tests/stress/out/logs');
const stress = supervisor('stress', { logDir });
stress.say(`stack output: ${path.relative(ROOT, logDir)}/`);

const stack = await startStack(stress, scenario);
const apiMemoryBefore = stack.apiMemory();
const k6 = await runK6(stress, scenario, stack.baseUrls);

const verdicts = [
  { name: 'k6 thresholds', pass: k6.passed },
  ...(await scenario.check({
    scenario,
    summary: k6.summary,
    stack,
    apiMemoryBefore,
    say: stress.say,
  })),
];
report(stress.say, k6.summary, verdicts);

await stack.close();
await stress.shutdown(verdicts.every((verdict) => verdict.pass) ? 0 : 1);
