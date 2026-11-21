import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaleCache, SaleView } from '../sale/cache.js';
import { createGateway, type Gateway } from './gateway.js';

const activeView: SaleView = {
  status: 'active',
  availability: 'plenty',
  startAt: '2026-11-20T10:00:00.000Z',
  endAt: '2026-11-20T11:00:00.000Z',
};

let httpServer: HttpServer;
let gateway: Gateway;
let port: number;
const clients: ClientSocket[] = [];
let view: SaleView | undefined = activeView;

/** Resolves on the next occurrence of an event, or rejects rather than hanging. */
function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no "${event}" within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function client(userId?: string): Promise<ClientSocket> {
  const socket = connect(`http://127.0.0.1:${port}`, {
    auth: userId === undefined ? {} : { userId },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

beforeEach(async () => {
  view = activeView;
  httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  port = (httpServer.address() as AddressInfo).port;

  gateway = createGateway({
    httpServer,
    saleCache: { view: () => view } as unknown as SaleCache,
    // Long intervals: these tests drive the gateway directly rather than
    // waiting on timers, which would make them slow and flaky.
    presenceIntervalMs: 60_000,
    statusIntervalMs: 60_000,
  });
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.close();
  await gateway.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('realtime gateway', () => {
  it('delivers a result to the user it belongs to, and nobody else', async () => {
    const alice = await client('alice');
    const bob = await client('bob');
    await Promise.all([once(alice, 'sale:status'), once(bob, 'sale:status')]);

    const delivered = once(alice, 'purchase:result');
    let bobGotOne = false;
    bob.on('purchase:result', () => (bobGotOne = true));

    gateway.handleResults({
      saleId: 'flash',
      results: [{ attemptId: 'a1', userId: 'alice', status: 'confirmed', orderId: 'order-1' }],
    });

    expect(await delivered).toMatchObject({ userId: 'alice', status: 'confirmed' });
    expect(bobGotOne).toBe(false);
  });

  it('discards a result for a user held by another instance', async () => {
    const alice = await client('alice');
    await once(alice, 'sale:status');

    // Every instance receives every batch; this one holds nobody named in it.
    expect(() =>
      gateway.handleResults({
        saleId: 'flash',
        results: [{ attemptId: 'a1', userId: 'carol', status: 'sold_out' }],
      }),
    ).not.toThrow();
  });

  it('greets a new socket with the current sale, not silence', async () => {
    const alice = await client('alice');

    expect(await once(alice, 'sale:status')).toMatchObject({
      status: 'active',
      availability: 'plenty',
    });
  });

  it('refuses a socket that does not say who it is', async () => {
    // Nothing could ever be routed to it, so holding the connection is worse
    // than refusing: the client would wait for results that cannot arrive.
    // Refused during the handshake, so the client sees `connect_error` rather
    // than connecting and being dropped for no stated reason.
    const anonymous = await client();

    const error = await once<Error>(anonymous, 'connect_error');

    expect(error.message).toBe('userId required');
    expect(anonymous.connected).toBe(false);
    expect(gateway.registry.connections).toBe(0);
  });

  it('counts both tabs of one user, and forgets them on disconnect', async () => {
    const first = await client('alice');
    const second = await client('alice');
    await Promise.all([once(first, 'sale:status'), once(second, 'sale:status')]);

    expect(gateway.registry.connections).toBe(2);
    expect(gateway.registry.users).toBe(1);

    second.close();
    await vi.waitFor(() => expect(gateway.registry.connections).toBe(1));
  });

  it('includes other instances in the viewer count', async () => {
    const alice = await client('alice');
    await once(alice, 'sale:status');

    gateway.handlePresence('another-instance', 41);

    // This instance's own socket plus the 41 announced elsewhere.
    expect(gateway.presence.total()).toBe(42);
  });

  it('does not count this instance twice when greeting a later socket', async () => {
    // `total()` already includes this instance once its count is recorded, so
    // adding the local socket count on top would double it.
    const first = await client('alice');
    await once(first, 'sale:viewers');

    const second = await client('bob');
    const greeting = await once<{ count: number }>(second, 'sale:viewers');

    expect(greeting.count).toBe(2);
  });
});
