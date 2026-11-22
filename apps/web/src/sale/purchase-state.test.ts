import type { PurchaseResultEvent } from '@flash-sale/core';
import { describe, expect, it } from 'vitest';

import {
  applyOwnResponse,
  applyResponse,
  applyResult,
  attemptOf,
  canPurchase,
  idle,
  isBusy,
  isTerminal,
  livePending,
  PENDING_TTL_MS,
  outcomeFromSale,
} from './purchase-state.js';

const queued = { status: 'queued', attemptId: 'ours' } as const;

const event = (over: Partial<PurchaseResultEvent>): PurchaseResultEvent => ({
  attemptId: 'ours',
  userId: 'alice',
  status: 'confirmed',
  ...over,
});

// The result can beat the 202 that names its attempt: both arrive within a
// couple of milliseconds, and the socket frame is handled first.
describe('applyOwnResponse', () => {
  const submitting = { status: 'submitting' } as const;

  it('keeps an order a result already delivered', () => {
    const held = { status: 'held', orderId: 'o1' } as const;

    expect(applyOwnResponse(held, queued, [])).toEqual(held);
  });

  it('applies our rejection that arrived before we knew our attempt id', () => {
    const early = [event({ status: 'sold_out' })];

    expect(applyOwnResponse(submitting, queued, early)).toEqual({
      status: 'rejected',
      reason: 'sold_out',
    });
  });

  it('ignores early results for other attempts', () => {
    const early = [event({ attemptId: 'another-tab', status: 'sold_out' })];

    expect(applyOwnResponse(submitting, queued, early)).toEqual(queued);
  });

  it('queues when nothing has arrived yet', () => {
    expect(applyOwnResponse(submitting, queued, [])).toEqual(queued);
  });

  it('takes a response that never reached the queue as it is', () => {
    expect(applyOwnResponse(submitting, { status: 'rateLimited' }, [])).toEqual({
      status: 'rateLimited',
    });
  });
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
    // Too early is not final: the sale opening is when to try again.
    expect(isTerminal({ status: 'rejected', reason: 'not_started' })).toBe(false);
    expect(isTerminal(idle)).toBe(false);
  });

  it('treats submitting and queued as busy, so the button stays disabled', () => {
    expect(isBusy({ status: 'submitting' })).toBe(true);
    expect(isBusy(queued)).toBe(true);
    expect(isBusy({ status: 'busy' })).toBe(false);
  });
});

describe('canPurchase', () => {
  const open = { status: 'active', availability: 'plenty' } as const;

  it('allows a named user into an open sale with stock', () => {
    expect(canPurchase(idle, 'alice', open, true)).toBe(true);
  });

  // A result decided before the server registered this user's socket is
  // pushed to nobody, and the page waits on it forever.
  it('needs the socket connected', () => {
    expect(canPurchase(idle, 'alice', open, false)).toBe(false);
  });

  it('allows a retry once the sale opens after a too-early attempt', () => {
    expect(canPurchase({ status: 'rejected', reason: 'not_started' }, 'alice', open, true)).toBe(
      true,
    );
  });

  it('needs a name', () => {
    expect(canPurchase(idle, '', open, true)).toBe(false);
  });

  it('needs the sale to be open and in stock', () => {
    expect(canPurchase(idle, 'alice', undefined, true)).toBe(false);
    expect(canPurchase(idle, 'alice', { status: 'upcoming' }, true)).toBe(false);
    expect(canPurchase(idle, 'alice', { status: 'ended' }, true)).toBe(false);
    expect(canPurchase(idle, 'alice', { status: 'active', availability: 'sold_out' }, true)).toBe(
      false,
    );
  });

  // Retrying after `busy` or `failed` is what those states are for, so only
  // in-flight and settled states block the button.
  it('blocks while in flight or settled, not after a retryable failure', () => {
    expect(canPurchase(queued, 'alice', open, true)).toBe(false);
    expect(canPurchase({ status: 'held', orderId: 'o1' }, 'alice', open, true)).toBe(false);
    expect(canPurchase({ status: 'busy' }, 'alice', open, true)).toBe(true);
    expect(canPurchase({ status: 'failed', message: 'x' }, 'alice', open, true)).toBe(true);
  });
});

describe('attemptOf', () => {
  it('is the attempt being waited on', () => {
    expect(attemptOf(queued)).toBe('ours');
  });

  // Before the 202 nobody knows it; once decided, nothing is waited on.
  it('is nothing before the attempt is queued or after it is decided', () => {
    expect(attemptOf({ status: 'submitting' })).toBeUndefined();
    expect(attemptOf({ status: 'held', orderId: 'o1' })).toBeUndefined();
    expect(attemptOf(idle)).toBeUndefined();
  });
});

describe('livePending', () => {
  const pending = { attemptId: 'ours', since: 1_000_000 };

  it('trusts an attempt younger than the limit', () => {
    expect(livePending(pending, pending.since + PENDING_TTL_MS - 1)).toEqual(pending);
  });

  // Its result was missed and the lookup found no order: offer Buy again.
  it('drops one that has outlived it', () => {
    expect(livePending(pending, pending.since + PENDING_TTL_MS)).toBeUndefined();
  });

  it('has nothing to restore when nothing was pending', () => {
    expect(livePending(undefined, pending.since)).toBeUndefined();
  });
});

describe('outcomeFromSale', () => {
  it('fails an attempt once the sale has ended', () => {
    expect(outcomeFromSale({ status: 'ended' })).toEqual({ status: 'rejected', reason: 'ended' });
  });

  it('fails an attempt once the sale has sold out', () => {
    expect(outcomeFromSale({ status: 'active', availability: 'sold_out' })).toEqual({
      status: 'rejected',
      reason: 'sold_out',
    });
  });

  it('leaves it undecided while it could still succeed', () => {
    expect(outcomeFromSale({ status: 'active', availability: 'low' })).toBeUndefined();
    expect(outcomeFromSale({ status: 'upcoming' })).toBeUndefined();
    expect(outcomeFromSale(undefined)).toBeUndefined();
  });
});
