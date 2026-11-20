import { describe, expect, it } from 'vitest';

import { availabilityOf, saleStatusAt, type SaleWindow } from './index.js';

const window: SaleWindow = {
  startAt: '2026-11-20T10:00:00.000Z',
  endAt: '2026-11-20T11:00:00.000Z',
};

describe('saleStatusAt', () => {
  it('is upcoming before the window opens', () => {
    expect(saleStatusAt(window, new Date('2026-11-20T09:59:59.999Z'))).toBe('upcoming');
  });

  it('is active on the opening instant', () => {
    expect(saleStatusAt(window, new Date('2026-11-20T10:00:00.000Z'))).toBe('active');
  });

  it('is ended on the closing instant, since the window is half-open', () => {
    expect(saleStatusAt(window, new Date('2026-11-20T11:00:00.000Z'))).toBe('ended');
  });

  it('does not depend on the ambient timezone', () => {
    // CI runs this suite twice, once under a non-UTC TZ (docs/PLAN.md §11).
    // A Date is an instant, so the result must not move when TZ does. Note the
    // assertion deliberately does not read `process`: core is shared with the
    // browser bundle and must not touch Node globals.
    expect(saleStatusAt(window, new Date('2026-11-20T10:30:00.000Z'))).toBe('active');
    expect(saleStatusAt(window, new Date(Date.UTC(2026, 10, 20, 10, 30)))).toBe('active');
  });
});

describe('availabilityOf', () => {
  it('reports sold_out at or below zero', () => {
    expect(availabilityOf(0, 1000)).toBe('sold_out');
    expect(availabilityOf(-1, 1000)).toBe('sold_out');
  });

  it('reports low within the last tenth of stock', () => {
    expect(availabilityOf(100, 1000)).toBe('low');
    expect(availabilityOf(1, 1000)).toBe('low');
  });

  it('reports plenty above that', () => {
    expect(availabilityOf(101, 1000)).toBe('plenty');
  });

  it('never leaks the exact count', () => {
    const values = [1, 50, 500, 999].map((n) => availabilityOf(n, 1000));
    expect(new Set(values).size).toBeLessThanOrEqual(3);
  });
});
