import { describe, expect, it } from 'vitest';

import { clockOffset, formatCountdown, remainingMs } from './clock.js';

const SERVER = '2026-11-20T10:00:00.000Z';

describe('clockOffset', () => {
  it('is zero when the clocks agree', () => {
    expect(clockOffset(SERVER, Date.parse(SERVER))).toBe(0);
  });

  it('is positive when the browser is behind', () => {
    expect(clockOffset(SERVER, Date.parse(SERVER) - 30_000)).toBe(30_000);
  });

  it('is negative when the browser is ahead', () => {
    expect(clockOffset(SERVER, Date.parse(SERVER) + 30_000)).toBe(-30_000);
  });
});

describe('remainingMs', () => {
  const target = '2026-11-20T10:01:00.000Z';

  it('counts down from the server clock, not the browser’s', () => {
    // Browser is five minutes fast. Uncorrected it would say the sale is over;
    // corrected it still has a minute (docs/PLAN.md §9.1).
    const browserNow = Date.parse(SERVER) + 5 * 60_000;
    const offset = clockOffset(SERVER, browserNow);

    expect(remainingMs(target, offset, browserNow)).toBe(60_000);
  });

  it('never goes negative', () => {
    const past = Date.parse(target) + 10_000;

    expect(remainingMs(target, 0, past)).toBe(0);
  });
});

describe('formatCountdown', () => {
  it('omits hours below one', () => {
    expect(formatCountdown(65_000)).toBe('01:05');
  });

  it('includes hours above one', () => {
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
  });

  it('pads seconds and minutes', () => {
    expect(formatCountdown(9_000)).toBe('00:09');
  });

  it('rounds down, so it never reaches zero early', () => {
    expect(formatCountdown(1_999)).toBe('00:01');
    expect(formatCountdown(0)).toBe('00:00');
  });
});
