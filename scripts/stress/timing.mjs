import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** How often each stack process prints where its time goes (apps/*\/src/stats.ts). */
export const STATS_INTERVAL_MS = 1_000;

/**
 * The last stats line each process printed to its log: its totals for the
 * run. Waits one interval first, so the line covers everything up to now.
 */
export async function readTiming(logDir, processes) {
  await new Promise((resolve) => setTimeout(resolve, STATS_INTERVAL_MS + 200));
  const timing = {};
  for (const name of processes) {
    const file = path.join(logDir, `${name}.log`);
    if (!existsSync(file)) continue;
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .reverse()
      .find((candidate) => candidate.startsWith('{"stats":'));
    if (line) timing[name] = JSON.parse(line);
  }
  return timing;
}
