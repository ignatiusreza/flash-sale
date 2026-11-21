export interface Deliverable {
  emit: (event: string, payload: unknown) => void;
}

/**
 * Which sockets this instance holds, by user.
 *
 * A result targets exactly one user, so an instance receiving one from the
 * fanout looks it up here and delivers or discards — no cross-instance room
 * broadcast is needed, and no shared adapter (docs/PLAN.md §8). The cost of
 * every instance seeing every result is bounded by the request rate, which is
 * far cheaper than keeping a registry of which instance holds whom.
 *
 * A user may hold several sockets: two tabs are one user.
 */
export class SocketRegistry {
  readonly #byUser = new Map<string, Set<Deliverable>>();

  add(userId: string, socket: Deliverable): void {
    const existing = this.#byUser.get(userId);
    if (existing) existing.add(socket);
    else this.#byUser.set(userId, new Set([socket]));
  }

  remove(userId: string, socket: Deliverable): void {
    const sockets = this.#byUser.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    // Drop the entry rather than leaving an empty set: over a sale this is the
    // difference between a bounded map and one key per visitor, for good.
    if (sockets.size === 0) this.#byUser.delete(userId);
  }

  /** Returns how many sockets received it — 0 when the user is on another instance. */
  deliver(userId: string, event: string, payload: unknown): number {
    const sockets = this.#byUser.get(userId);
    if (!sockets) return 0;
    for (const socket of sockets) socket.emit(event, payload);
    return sockets.size;
  }

  broadcast(event: string, payload: unknown): void {
    for (const sockets of this.#byUser.values()) {
      for (const socket of sockets) socket.emit(event, payload);
    }
  }

  /** Sockets held, not distinct users: two tabs count twice. */
  get connections(): number {
    let total = 0;
    for (const sockets of this.#byUser.values()) total += sockets.size;
    return total;
  }

  get users(): number {
    return this.#byUser.size;
  }
}
