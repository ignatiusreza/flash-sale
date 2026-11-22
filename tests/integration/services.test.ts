import net from 'node:net';

import { describe, expect, it } from 'vitest';

/**
 * Proves the suite reaches the Postgres and RabbitMQ it was pointed at —
 * local defaults, `.env`, CI service containers, or the compose runner by
 * service name. Which ports those are belongs to the environment, so only
 * reachability is asserted.
 *
 * Skipped when no URL resolved (see tests/setup/services.ts), so `pnpm test` on
 * a checkout with no services still runs the unit tests.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const RABBITMQ_URL = process.env.RABBITMQ_URL;

function hostPortOf(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port) };
}

function canConnect({ host, port }: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const settle = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(5000);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

describe.skipIf(!DATABASE_URL || !RABBITMQ_URL)('services', () => {
  it('reaches Postgres at the configured URL', async () => {
    expect(await canConnect(hostPortOf(DATABASE_URL!))).toBe(true);
  });

  it('reaches RabbitMQ at the configured URL', async () => {
    expect(await canConnect(hostPortOf(RABBITMQ_URL!))).toBe(true);
  });
});
