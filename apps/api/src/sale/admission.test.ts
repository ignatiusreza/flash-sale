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

  // Just before the open, or just after the close, this host may disagree with
  // the database's clock the claim judges by: refusing there could be wrong.
  it('admits only in the grace just before the open and just after the close', async () => {
    const sale = await cache();

    expect(admit(sale, at(START, -EDGE_GRACE_MS / 2))).toEqual({ admit: true });
    expect(admit(sale, at(END, EDGE_GRACE_MS / 2))).toEqual({ admit: true });
  });

  // The pre-sale rush is the busiest moment, and must still be refused from
  // memory up to the grace — not for a whole second before the open.
  it('still refuses the pre-sale rush outside that grace', async () => {
    const sale = await cache();

    expect(admit(sale, at(START, -500))).toEqual({ admit: false, reason: 'not_started' });
    expect(admit(sale, at(END, 500))).toEqual({ admit: false, reason: 'ended' });
  });

  it('refuses a sold-out sale on either side of the close, grace or not', async () => {
    const sale = await cache(0);

    expect(admit(sale, at(END, -EDGE_GRACE_MS / 2))).toEqual({ admit: false, reason: 'sold_out' });
    expect(admit(sale, at(END, EDGE_GRACE_MS / 2))).toEqual({ admit: false, reason: 'sold_out' });
  });

  it('refuses a sold-out sale inside its window', async () => {
    const sale = await cache(0);

    expect(admit(sale, at(START, 60_000))).toEqual({ admit: false, reason: 'sold_out' });
  });
});
