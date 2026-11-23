import { existsSync, readFileSync } from 'node:fs';

export async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`gave up waiting after ${timeoutMs} ms`);
}

export async function untilOk(url) {
  await until(async () => (await fetch(url).catch(() => undefined))?.ok === true, 30_000);
}

/** Resident memory of a child process, in kB. */
export function rssOf(child) {
  const status = `/proc/${child.pid}/status`;
  if (!existsSync(status)) return 0;
  const match = /VmRSS:\s+(\d+)/.exec(readFileSync(status, 'utf8'));
  return match ? Number(match[1]) : 0;
}

/** A counter from the k6 summary, 0 if the run never recorded it. */
export function count(summary, metric) {
  return summary.metrics[metric]?.values?.count ?? 0;
}
