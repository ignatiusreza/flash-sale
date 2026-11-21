import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { SaleCache } from './cache.js';

const START = new Date('2026-11-20T10:00:00.000Z');
const END = new Date('2026-11-20T11:00:00.000Z');

function cacheWith(remaining: number, totalStock = 100): SaleCache {
  const pool = {
    query: vi.fn().mockResolvedValue({
      rows: [{ start_at: START, end_at: END, total_stock: totalStock, remaining }],
    }),
  } as unknown as pg.Pool;
  return new SaleCache(pool, 'flash', 1000);
}

describe('SaleCache.view', () => {
  it('pairs availability with an active sale', async () => {
    const cache = cacheWith(50);
    await cache.refresh();

    expect(cache.view(new Date('2026-11-20T10:30:00.000Z'))).toEqual({
      status: 'active',
      availability: 'plenty',
      startAt: START.toISOString(),
      endAt: END.toISOString(),
    });
  });

  it('never reports stock for a sale that has ended, however much is left', async () => {
    // The combination that prompted this: status `ended` beside `plenty` reads
    // as an offer, and there is none.
    const cache = cacheWith(99);
    await cache.refresh();

    const view = cache.view(new Date('2026-11-20T12:00:00.000Z'));

    expect(view?.status).toBe('ended');
    expect(view?.availability).toBeUndefined();
  });

  it('never reports stock before the sale opens', async () => {
    const cache = cacheWith(100);
    await cache.refresh();

    const view = cache.view(new Date('2026-11-20T09:00:00.000Z'));

    expect(view?.status).toBe('upcoming');
    expect(view?.availability).toBeUndefined();
  });

  it('still reports sold_out while the window is open', async () => {
    const cache = cacheWith(0);
    await cache.refresh();

    expect(cache.view(new Date('2026-11-20T10:30:00.000Z'))).toMatchObject({
      status: 'active',
      availability: 'sold_out',
    });
  });

  it('keeps serving the last snapshot when a refresh fails', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ start_at: START, end_at: END, total_stock: 100, remaining: 10 }],
      })
      .mockRejectedValueOnce(new Error('connection lost'));
    const cache = new SaleCache({ query } as unknown as pg.Pool, 'flash', 1000);

    await cache.refresh();
    await cache.refresh();

    // Degraded freshness rather than a dead status endpoint, but honest about
    // being unhealthy so readiness can act on it.
    expect(cache.view(new Date('2026-11-20T10:30:00.000Z'))?.availability).toBe('low');
    expect(cache.healthy).toBe(false);
  });
});
