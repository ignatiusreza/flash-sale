import type { PurchaseResultEvent } from '@flash-sale/core';
import { describe, expect, it } from 'vitest';

import { applyResponse, applyResult, idle, isBusy, isTerminal } from './purchase-state.js';

const queued = { status: 'queued', attemptId: 'ours' } as const;

const event = (over: Partial<PurchaseResultEvent>): PurchaseResultEvent => ({
  attemptId: 'ours',
  userId: 'alice',
  status: 'confirmed',
  ...over,
});

describe('applyResult', () => {
  it('holds the order when our attempt wins', () => {
    const next = applyResult(queued, event({ status: 'confirmed', orderId: 'o1' }), 'ours');

    expect(next).toEqual({ status: 'held', orderId: 'o1' });
  });

  it('treats already_purchased as holding the same order', () => {
    // The same fact to a person. Distinguishing them is what makes a second
    // tab's result look like a different outcome.
    const next = applyResult(queued, event({ status: 'already_purchased', orderId: 'o1' }), 'ours');

    expect(next).toEqual({ status: 'held', orderId: 'o1' });
  });

  it('accepts an order from another tab’s attempt', () => {
    // Results arrive per user, so this tab learns it holds an order even
    // though a different tab asked for it.
    const next = applyResult(idle, event({ attemptId: 'other-tab', orderId: 'o1' }), 'ours');

    expect(next).toEqual({ status: 'held', orderId: 'o1' });
  });

  it('does not let another tab’s rejection clobber our state', () => {
    // A rejection says nothing about our attempt, and applying it would undo
    // a state this tab legitimately reached.
    const held = { status: 'held', orderId: 'o1' } as const;

    const next = applyResult(held, event({ attemptId: 'other', status: 'sold_out' }), 'ours');

    expect(next).toBe(held);
  });

  it.each(['sold_out', 'not_started', 'ended'] as const)('records our own %s', (reason) => {
    const next = applyResult(queued, event({ status: reason }), 'ours');

    expect(next).toEqual({ status: 'rejected', reason });
  });

  it('ignores a success with no order rather than inventing one', () => {
    const next = applyResult(queued, event({ status: 'confirmed' }), 'ours');

    expect(next).toBe(queued);
  });

  it('never leaves a held order for a rejection, even our own', () => {
    // Ordering is not guaranteed; a late rejection must not evict the order.
    const held = { status: 'held', orderId: 'o1' } as const;

    expect(applyResult(held, event({ status: 'sold_out' }), 'ours')).toEqual({
      status: 'rejected',
      reason: 'sold_out',
    });
  });
});

describe('applyResponse', () => {
  it('queues on 202', () => {
    expect(applyResponse(202, { status: 'queued', attemptId: 'a1' })).toEqual({
      status: 'queued',
      attemptId: 'a1',
    });
  });

  it.each(['sold_out', 'not_started', 'ended'] as const)('rejects on 409 %s', (reason) => {
    expect(applyResponse(409, { status: reason })).toEqual({ status: 'rejected', reason });
  });

  it('reports rate limiting and busy separately, since one is our fault', () => {
    expect(applyResponse(429, { error: 'rate_limited' })).toEqual({ status: 'rateLimited' });
    expect(applyResponse(503, { error: 'busy' })).toEqual({ status: 'busy' });
  });

  it('falls back to a message rather than a blank screen', () => {
    expect(applyResponse(500, {})).toMatchObject({ status: 'failed' });
    expect(applyResponse(400, { error: 'bad' })).toEqual({ status: 'failed', message: 'bad' });
  });
});

describe('state predicates', () => {
  it('treats held and rejected as terminal', () => {
    expect(isTerminal({ status: 'held', orderId: 'o' })).toBe(true);
    expect(isTerminal({ status: 'rejected', reason: 'ended' })).toBe(true);
    expect(isTerminal(idle)).toBe(false);
  });

  it('treats submitting and queued as busy, so the button stays disabled', () => {
    expect(isBusy({ status: 'submitting' })).toBe(true);
    expect(isBusy(queued)).toBe(true);
    expect(isBusy({ status: 'busy' })).toBe(false);
  });
});
