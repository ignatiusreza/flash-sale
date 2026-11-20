import net from 'node:net';

import { describe, expect, it } from 'vitest';

/**
 * Proves the containerised runner reaches Postgres and RabbitMQ by *service
 * name* over the compose network, with no host port involved — which is the
 * whole point of running the suite inside Docker.
 *
 * Skipped when the URLs are absent, so `pnpm test` on a bare checkout stays
 * green. Phase 1 replaces this with driver-level checks once there is a schema
 * and a queue worth talking to; for now it only asserts reachability.
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

describe.skipIf(!DATABASE_URL || !RABBITMQ_URL)('compose services', () => {
  it('resolves Postgres by service name', async () => {
    const target = hostPortOf(DATABASE_URL!);
    expect(target.host).not.toBe('localhost');
    expect(await canConnect(target)).toBe(true);
  });

  it('resolves RabbitMQ by service name', async () => {
    const target = hostPortOf(RABBITMQ_URL!);
    expect(target.host).not.toBe('localhost');
    expect(await canConnect(target)).toBe(true);
  });

  it('uses the services native ports, not a remapped host port', () => {
    expect(hostPortOf(DATABASE_URL!).port).toBe(5432);
    expect(hostPortOf(RABBITMQ_URL!).port).toBe(5672);
  });
});
