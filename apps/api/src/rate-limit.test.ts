import { describe, expect, it } from 'vitest';

import { TokenBucket } from './rate-limit.js';

describe('TokenBucket', () => {
  it('allows up to capacity, then refuses', () => {
    const bucket = TokenBucket.perMinute(3);
    const now = 1_000_000;

    expect([0, 1, 2, 3].map(() => bucket.take('ip', now))).toEqual([true, true, true, false]);
  });

  it('refills over time rather than resetting on a window boundary', () => {
    const bucket = TokenBucket.perMinute(60); // one token per second
    const start = 1_000_000;
    for (let i = 0; i < 60; i++) bucket.take('ip', start);
    expect(bucket.take('ip', start)).toBe(false);

    expect(bucket.take('ip', start + 1_000)).toBe(true);
    expect(bucket.take('ip', start + 1_000)).toBe(false);
  });

  it('keeps callers independent', () => {
    const bucket = TokenBucket.perMinute(1);
    const now = 1_000_000;

    expect(bucket.take('alice', now)).toBe(true);
    expect(bucket.take('bob', now)).toBe(true);
    expect(bucket.take('alice', now)).toBe(false);
  });

  it('never exceeds capacity however long it idles', () => {
    const bucket = TokenBucket.perMinute(2);
    const start = 1_000_000;
    bucket.take('ip', start);

    const muchLater = start + 60 * 60_000;
    expect(bucket.take('ip', muchLater)).toBe(true);
    expect(bucket.take('ip', muchLater)).toBe(true);
    expect(bucket.take('ip', muchLater)).toBe(false);
  });

  it('evicts fully refilled buckets, so a sale does not leak one key per user', () => {
    const bucket = TokenBucket.perMinute(60);
    const start = 1_000_000;
    for (let i = 0; i < 500; i++) bucket.take(`user-${i}`, start);
    expect(bucket.size).toBe(500);

    bucket.evictIdle(start + 60_000);

    expect(bucket.size).toBe(0);
  });

  it('keeps buckets that are still spending', () => {
    const bucket = TokenBucket.perMinute(60);
    const start = 1_000_000;
    bucket.take('busy', start);

    bucket.evictIdle(start + 1_000);

    expect(bucket.size).toBe(1);
  });
});
