/**
 * Token bucket, held in process.
 *
 * Per-instance rather than shared, which means the effective limit across N
 * API instances is N times the configured one. That is a real caveat and it is
 * stated rather than hidden: a shared counter would need a store every request
 * touches, and this design deliberately has no Redis (docs/PLAN.md §12). The
 * limiter exists to blunt a single abusive client, not to enforce a precise
 * global quota — the bounded queue and the claim are what actually protect the
 * sale.
 */
export class TokenBucket {
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {}

  static perMinute(limit: number): TokenBucket {
    return new TokenBucket(limit, limit / 60_000);
  }

  /** True when the caller may proceed, consuming a token. */
  take(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const refilled = Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs,
    );

    if (refilled < 1) {
      this.#buckets.set(key, { tokens: refilled, updatedAt: now });
      return false;
    }

    this.#buckets.set(key, { tokens: refilled - 1, updatedAt: now });
    return true;
  }

  /**
   * Drops buckets that have refilled completely — they are indistinguishable
   * from a fresh one, so keeping them only grows the map. Without this a flash
   * sale's worth of unique keys stays resident for the life of the process.
   */
  evictIdle(now = Date.now()): void {
    const fullAfterMs = this.capacity / this.refillPerMs;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt >= fullAfterMs) this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}
