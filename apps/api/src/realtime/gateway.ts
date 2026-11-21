import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import type { PurchaseResultsMessage } from '@flash-sale/messaging';
import { Server, type Socket } from 'socket.io';

import type { SaleCache, SaleView } from '../sale/cache.js';
import { PresenceTracker } from './presence.js';
import { SocketRegistry } from './sockets.js';

export interface GatewayOptions {
  readonly httpServer: HttpServer;
  readonly saleCache: SaleCache;
  /** Announce this instance's socket count. No-op when running without a broker. */
  readonly announcePresence?: (connections: number, instanceId: string) => void;
  readonly presenceIntervalMs?: number;
  /** Instances quiet for this long stop counting towards the viewer total. */
  readonly presenceStaleMs?: number;
  readonly statusIntervalMs?: number;
}

export interface Gateway {
  readonly io: Server;
  readonly registry: SocketRegistry;
  readonly presence: PresenceTracker;
  readonly instanceId: string;
  /** Called with whatever arrives on the fanout's results routing key. */
  handleResults: (message: PurchaseResultsMessage) => void;
  handlePresence: (instanceId: string, connections: number) => void;
  close: () => Promise<void>;
}

/** A socket announces who it is; there is no auth in this exercise (§2.2). */
function userIdOf(socket: Socket): string | undefined {
  const fromAuth = (socket.handshake.auth as { userId?: unknown } | undefined)?.userId;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;
  const fromQuery = socket.handshake.query['userId'];
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : undefined;
}

export function createGateway(options: GatewayOptions): Gateway {
  const instanceId = randomUUID();
  const registry = new SocketRegistry();
  const presenceStaleMs = options.presenceStaleMs ?? 15_000;
  const presence = new PresenceTracker(presenceStaleMs);

  const io = new Server(options.httpServer, {
    // The browser is served from a different origin in development, and in
    // production from whatever fronts the API. Same-origin is not assumable.
    cors: { origin: true, credentials: true },
    serveClient: false,
  });

  // Refused during the handshake rather than after connecting. Nothing can be
  // routed to an unidentified socket, so holding one is worse than refusing:
  // the client would wait for results that can never arrive. Emitting a reason
  // and then disconnecting races — the packet need not flush first — whereas a
  // middleware rejection reaches the client as `connect_error`.
  io.use((socket, next) => {
    next(userIdOf(socket) ? undefined : new Error('userId required'));
  });

  io.on('connection', (socket) => {
    const userId = userIdOf(socket)!;

    registry.add(userId, socket);
    socket.on('disconnect', () => registry.remove(userId, socket));

    // Greet with current state: a client that connects mid-sale should not
    // have to wait for the next broadcast to know what is going on.
    const view = options.saleCache.view();
    if (view) socket.emit('sale:status', view);

    // Refresh our own entry before reading the total rather than adding to it:
    // once the timer has recorded this instance, `total()` already includes it,
    // and adding `registry.connections` would count this instance twice.
    presence.record(instanceId, registry.connections);
    socket.emit('sale:viewers', { count: presence.total() });
  });

  function handleResults(message: PurchaseResultsMessage): void {
    // Every instance sees every batch; each delivers only what it holds.
    for (const result of message.results) {
      registry.deliver(result.userId, 'purchase:result', result);
    }
  }

  function handlePresence(fromInstance: string, connections: number): void {
    presence.record(fromInstance, connections);
  }

  // Announce once on startup so peers know this instance exists — and so their
  // expiry has something to expire — rather than waiting a full interval.
  //
  // The total is eventually consistent either way: an instance cannot know a
  // peer's count until the peer announces it, so a new instance reports only
  // its own sockets for up to one interval. Measured across two instances
  // holding three sockets, the second settled from 1 to 3 within two rounds.
  // That is the cost of aggregating instead of keeping a shared registry, and
  // it is acceptable because the number is decorative (docs/PLAN.md §8).
  options.announcePresence?.(0, instanceId);

  // Announce this instance's count, and tell our own sockets the total.
  const presenceTimer = setInterval(() => {
    const own = registry.connections;
    options.announcePresence?.(own, instanceId);
    presence.record(instanceId, own);
    registry.broadcast('sale:viewers', { count: presence.total() });
  }, options.presenceIntervalMs ?? 3_000);
  presenceTimer.unref();

  // Push status transitions rather than making every client poll for them.
  let lastStatus: string | undefined;
  const statusTimer = setInterval(() => {
    const view: SaleView | undefined = options.saleCache.view();
    if (!view) return;
    const signature = `${view.status}:${view.availability ?? ''}`;
    if (signature === lastStatus) return;
    lastStatus = signature;
    registry.broadcast('sale:status', view);
  }, options.statusIntervalMs ?? 1_000);
  statusTimer.unref();

  return {
    io,
    registry,
    presence,
    instanceId,
    handleResults,
    handlePresence,
    close: async () => {
      clearInterval(presenceTimer);
      clearInterval(statusTimer);
      await io.close();
    },
  };
}
