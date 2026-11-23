import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/stack.mjs';

const K6_IMAGE = 'grafana/k6:2.3.0';
/** Named, so it can be removed: stopping `docker run` leaves its container running. */
const CONTAINER = 'flash-sale-stress-k6';
const OUT = path.join(ROOT, 'tests/stress/out');

/**
 * Runs `tests/stress/<scenario>.js` in k6's container against `baseUrls`.
 * k6 is AGPL: it runs as its own program over the wire, never linked in.
 * Resolves whether its thresholds passed, and the summary it wrote.
 */
export async function runK6(stress, scenario, baseUrls) {
  mkdirSync(OUT, { recursive: true });
  const removeContainer = () =>
    spawnSync('docker', ['rm', '--force', CONTAINER], { stdio: 'ignore' });
  // One a crashed run left behind would still be hammering the next stack.
  removeContainer();
  stress.onShutdown(removeContainer);
  const env = { BASE_URLS: baseUrls.join(','), ...scenario.k6Env };

  stress.say(`running k6 (${scenario.name})…`);
  const passed = await stress
    .run(
      'docker',
      [
        'run',
        '--rm',
        `--name=${CONTAINER}`,
        '--network=host',
        // As us, so the summary it writes into OUT is ours to read and delete.
        `--user=${process.getuid()}:${process.getgid()}`,
        '-v',
        `${path.join(ROOT, 'tests/stress')}:/scripts:ro`,
        '-v',
        `${OUT}:/out`,
        ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        K6_IMAGE,
        'run',
        '--quiet',
        `/scripts/${scenario.name}.js`,
      ],
      {},
      { logAs: 'k6' },
    )
    .then(
      () => true,
      () => false,
    );

  const summary = JSON.parse(readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
  return { passed, summary };
}
