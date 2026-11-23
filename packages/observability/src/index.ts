/**
 * What the API and worker report about themselves: their logs, and — for the
 * stress harness — where their time goes. Node-only, so kept out of `core`,
 * which the browser bundle depends on.
 */
export { createLogger, type LoggerOptions, type ProcessLogger } from './logger.js';
export { startStats, type Stats } from './stats.js';
