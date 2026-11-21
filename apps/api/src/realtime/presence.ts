/**
 * Sums the socket counts every API instance announces.
 *
 * Aggregated rather than exact, deliberately: broadcasting per-connection
 * accounting to everyone is O(N²), and "X people are looking at this" does not
 * need to be right to the person (docs/PLAN.md §8).
 *
 * An instance that stops announcing — crashed, or network-partitioned — has its
 * count expired rather than counted for ever. Without that, the viewer number
 * only ever climbs, and a restart loop would inflate it indefinitely.
 */
export class PresenceTracker {
  readonly #counts = new Map<string, { connections: number; seenAt: number }>();

  constructor(private readonly staleAfterMs: number) {}

  record(instanceId: string, connections: number, now = Date.now()): void {
    this.#counts.set(instanceId, { connections, seenAt: now });
  }

  /** Total across instances still announcing, expiring the rest as it goes. */
  total(now = Date.now()): number {
    let total = 0;
    for (const [instanceId, entry] of this.#counts) {
      if (now - entry.seenAt >= this.staleAfterMs) {
        this.#counts.delete(instanceId);
        continue;
      }
      total += entry.connections;
    }
    return total;
  }

  get instances(): number {
    return this.#counts.size;
  }
}
