import { checkLoad, checkSale, checkShedding } from './checks.mjs';

/**
 * Every scenario takes the same settings, and each can be overridden from the
 * environment under one name, whichever scenario runs:
 *
 * | Setting     | Variable            | Means                                        |
 * | ----------- | ------------------- | -------------------------------------------- |
 * | `rate`      | `STRESS_RATE`       | the headline arrival rate, attempts/s        |
 * | `holdS`     | `STRESS_HOLD_S`     | how long that rate is held, seconds          |
 * | `probeRate` | `STRESS_PROBE_RATE` | buyers on the socket per second, timed       |
 * | `stock`     | `STRESS_STOCK`      | units in the sale                            |
 * | `queueMax`  | `STRESS_QUEUE_MAX`  | the attempts queue's bound                   |
 *
 * k6 receives the first three as `RATE`, `HOLD_S` and `PROBE_RATE`
 * (tests/stress/lib/settings.js); the defaults live here and nowhere else.
 */
const VARIABLES = {
  rate: 'STRESS_RATE',
  holdS: 'STRESS_HOLD_S',
  probeRate: 'STRESS_PROBE_RATE',
  stock: 'STRESS_STOCK',
  queueMax: 'STRESS_QUEUE_MAX',
};

/**
 * Per scenario: the defaults, whether the worker runs from the start or only
 * after the load, and `check`, which turns the k6 summary and the database
 * into named pass/fail verdicts.
 */
export const SCENARIOS = {
  // An oversubscribed sale: the rush at `rate` sells out early; `probeRate`
  // buyers are timed in a quiet phase before it.
  sale: {
    defaults: { rate: 10_000, holdS: 20, probeRate: 300, stock: 20_000 },
    worker: 'from the start',
    check: checkSale,
  },
  // Every attempt a real claim: stock that never sells out, `probeRate`
  // buyers timed throughout the hold.
  load: {
    defaults: { rate: 10_000, holdS: 20, probeRate: 200, stock: 10_000_000 },
    worker: 'from the start',
    check: checkLoad,
  },
  // Past the bound: `rate` against a stopped worker and a queue of `queueMax`.
  shedding: {
    defaults: { rate: 5_000, holdS: 10, stock: 1_000_000, queueMax: 2_000 },
    worker: 'after the load',
    check: checkShedding,
  },
  // Exploratory: the ceiling, with every attempt queued.
  capacity: {
    defaults: { rate: 20_000, holdS: 30, stock: 10_000_000 },
    worker: 'from the start',
    check: async () => [],
  },
};

/** The scenario called `name`, with any overrides from `env` applied. */
export function scenarioNamed(name, env = process.env) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    throw new Error(`unknown scenario "${name}": ${Object.keys(SCENARIOS).join(', ')}`);
  }

  const settings = { ...scenario.defaults };
  for (const [setting, variable] of Object.entries(VARIABLES)) {
    if (env[variable]) settings[setting] = Number(env[variable]);
  }

  return {
    name,
    worker: scenario.worker,
    check: scenario.check,
    ...settings,
    // What k6 is told: only what the scenario uses.
    k6Env: {
      RATE: settings.rate,
      HOLD_S: settings.holdS,
      ...(settings.probeRate ? { PROBE_RATE: settings.probeRate } : {}),
    },
  };
}
