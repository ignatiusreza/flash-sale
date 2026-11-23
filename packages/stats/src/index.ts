import { createHistogram, monitorEventLoopDelay, type RecordableHistogram } from 'node:perf_hooks';

export interface Stats {
  /** Records one value under `name`: a duration in milliseconds, or a count. */
  record: (name: string, ms: number) => void;
}

/**
 * Where a process's time goes, for the stress harness to read (issue #17):
 * event-loop delay in milliseconds, plus whatever the caller records. Every
 * `intervalMs` it prints one JSON line of the totals so far — p50, p99 and max
 * — to stdout, which the harness sends to this process's log.
 *
 * Off unless asked for (`STATS_INTERVAL_MS`): it is a measuring tool, not
 * monitoring, and a process nobody is measuring should not pay for it.
 */
const RESOLUTION_MS = 10;

function lagOnly(summary: { p50: number; p99: number; max: number }) {
  const lag = (ms: number) => Math.max(0, ms - RESOLUTION_MS);
  return { ...summary, p50: lag(summary.p50), p99: lag(summary.p99), max: lag(summary.max) };
}

export function startStats(name: string, intervalMs: number): Stats {
  // Sampled every RESOLUTION_MS, and each sample includes that wait.
  const eventLoop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  eventLoop.enable();
  const histograms = new Map<string, RecordableHistogram>();

  // Histograms take integers: thousandths keep sub-millisecond precision.
  const summary = (
    histogram: { count?: number; percentile: (p: number) => number; max: number },
    unit: number,
  ) => ({
    ...(histogram.count === undefined ? {} : { count: histogram.count }),
    p50: histogram.percentile(50) / unit,
    p99: histogram.percentile(99) / unit,
    max: histogram.max / unit,
  });

  const timer = setInterval(() => {
    const line: Record<string, unknown> = {
      stats: name,
      // Nanoseconds, less the sampling interval itself: only the lag.
      eventLoop: lagOnly(summary(eventLoop, 1e6)),
    };
    for (const [recorded, histogram] of histograms) {
      line[recorded] = summary(histogram, 1e3);
    }
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }, intervalMs);
  timer.unref();

  return {
    record: (recorded, ms) => {
      let histogram = histograms.get(recorded);
      if (!histogram) {
        histogram = createHistogram();
        histograms.set(recorded, histogram);
      }
      histogram.record(Math.max(1, Math.round(ms * 1000)));
    },
  };
}
