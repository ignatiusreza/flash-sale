/**
 * The settings every scenario takes, as the orchestrator passes them — it owns
 * the defaults (scripts/stress/scenarios.mjs), so there are none here, and a
 * script run outside `pnpm stress` fails at once rather than on guesses.
 *
 * - `RATE`: the scenario's headline arrival rate, attempts per second.
 * - `HOLD_S`: how long that rate is held, in seconds.
 * - `PROBE_RATE`: buyers on the socket per second, timed from POST to result;
 *   only the scenarios that time anyone use it.
 */
export const BASES = required('BASE_URLS').split(',');
export const RATE = Number(required('RATE'));
export const HOLD_S = Number(required('HOLD_S'));
export const PROBE_RATE = Number(__ENV.PROBE_RATE || 0);

function required(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`${name} is not set: run this through \`pnpm stress\``);
  return value;
}
