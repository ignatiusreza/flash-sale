import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { admit, EDGE_GRACE_MS } from './admission.js';
import { SaleCache } from './cache.js';

const START = new Date('2026-11-20T10:00:00.000Z');
const END = new Date('2026-11-20T11:00:00.000Z');

async function cache(remaining = 50): Promise<SaleCache> {
  const pool = {
    query: async () => ({
      rows: [{ start_at: START, end_at: END, total_stock: 100, remaining }],
    }),
  } as unknown as pg.Pool;
  const sale = new SaleCache(pool, 'flash', 1000);
  await sale.refresh();
  return sale;
}

const at = (edge: Date, offsetMs: number) => new Date(edge.getTime() + offsetMs);

describe('admit', () => {
  it('refuses well before the sale opens, and well after it closes', async () => {
    const sale = await cache();

    expect(admit(sale, at(START, -60_000))).toEqual({ admit: false, reason: 'not_started' });
    expect(admit(sale, at(END, 60_000))).toEqual({ admit: false, reason: 'ended' });
  });

  // The cache only estimates the database's clock, and the claim is the
  // authority: this close to an edge, refusing could be wrong, while
  // admitting costs at most one queued attempt.
  it('admits near either edge, for the claim to judge', async () => {
    const sale = await cache();

    expect(admit(sale, at(START, -EDGE_GRACE_MS / 2))).toEqual({ admit: true });
    expect(admit(sale, at(END, EDGE_GRACE_MS / 2))).toEqual({ admit: true });
  });

  it('refuses a sold-out sale inside its window', async () => {
    const sale = await cache(0);

    expect(admit(sale, at(START, 60_000))).toEqual({ admit: false, reason: 'sold_out' });
  });
});
