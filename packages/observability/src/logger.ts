import { pino, type Logger } from 'pino';

export interface LoggerOptions {
  /** Names the process in every line. */
  readonly name: string;
  readonly level?: string;
  /** Human-readable lines, for a terminal: `pnpm dev`. */
  readonly pretty?: boolean;
}

export interface ProcessLogger {
  readonly logger: Logger;
  /** Writes out whatever is still buffered: call before exiting on purpose. */
  readonly flush: () => void;
}

/**
 * The process's logger, writing off the request path.
 *
 * Pino's default destination writes to stdout synchronously, on the main
 * thread: at `info`, two blocking writes per request, which the stress runs
 * showed up in the latency tail. Here stdout is written asynchronously instead,
 * buffered — so a process exiting on purpose flushes first, or its last lines,
 * often the reason it is exiting, are lost.
 *
 * `pretty` uses the `pino-pretty` transport, which runs in a worker thread of
 * its own. It is a development dependency, so only for `pnpm dev`: the
 * production images do not ship it.
 */
export function createLogger({
  name,
  level = 'info',
  pretty = false,
}: LoggerOptions): ProcessLogger {
  if (pretty) {
    const logger = pino({ name, level, transport: { target: 'pino-pretty' } });
    return { logger, flush: () => logger.flush() };
  }

  const destination = pino.destination({ dest: 1, sync: false });
  const logger = pino({ name, level }, destination);
  return { logger, flush: () => destination.flushSync() };
}
