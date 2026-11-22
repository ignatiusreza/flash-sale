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

  // A visitor who has not given a name yet still watches the sale: they get
  // its status and the viewer count, and count as a viewer, but nothing is
  // routed to them — they cannot buy, so no result is ever theirs.
  let anonymous = 0;
  const viewers = () => registry.users + anonymous;

  io.on('connection', (socket) => {
    const userId = userIdOf(socket);

    if (userId) {
      registry.add(userId, socket);
      socket.on('disconnect', () => registry.remove(userId, socket));
    } else {
      anonymous++;
      socket.on('disconnect', () => anonymous--);
    }

    // Greet with current state: a client that connects mid-sale should not
    // have to wait for the next broadcast to know what is going on.
    const view = options.saleCache.view();
    if (view) socket.emit('sale:status', view);

    // Refresh our own entry before reading the total rather than adding to it:
    // once the timer has recorded this instance, `total()` already includes it,
    // and adding our own count again would double this instance.
    presence.record(instanceId, viewers());
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
    // Distinct users, not sockets: "X people are looking at this" should not
    // triple because one person has three tabs open. This only dedupes within
    // an instance — the same user connected to two instances still counts
    // twice, and closing that would need the shared registry this design
    // deliberately avoids. Over-counting a decorative number slightly is the
    // cheaper mistake.
    const own = viewers();
    options.announcePresence?.(own, instanceId);
    presence.record(instanceId, own);
    // To every socket, named or not.
    io.emit('sale:viewers', { count: presence.total() });
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
    io.emit('sale:status', view);
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
