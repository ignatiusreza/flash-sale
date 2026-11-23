/**
 * The shape every held rate takes: ramped up from 1 000/s over a few seconds,
 * then held. Shared by the k6 scenarios, which build their stages from it,
 * and the orchestrator, which checks the rate was held — so imports nothing
 * from k6.
 */
export const RAMP_FROM = 1_000;
export const RAMP_S = 5;

/** k6 stages for `rate` reached over `rampS`, then held for `holdS`. */
export function rampThenHold(rate, holdS, rampS = RAMP_S) {
  return [
    { target: rate, duration: `${rampS}s` },
    { target: rate, duration: `${holdS}s` },
  ];
}

/**
 * How many attempts a ramp-then-hold plans to start. The rate counts as held
 * when nearly all of them were sent: k6 drops what it cannot start on time,
 * and on a laptop running everything a handful always are.
 */
export function plannedAttempts(rate, holdS, rampS = RAMP_S) {
  return (rampS * (RAMP_FROM + rate)) / 2 + rate * holdS;
}
