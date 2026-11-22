import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookupOrder, lookupOrderUntilKnown } from './api.js';

function answer(status: number, body: unknown = [], headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookupOrder', () => {
  it('reports the order a user holds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(200, [{ orderId: 'o1' }])));

    expect(await lookupOrder('alice')).toEqual({ status: 'held', orderId: 'o1' });
  });

  it('reports none only from a successful answer listing nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(200, [])));

    expect(await lookupOrder('alice')).toEqual({ status: 'none' });
  });

  // A failed lookup knows nothing: read as "none", it turned a winner whose
  // result was lost into "Sold out" (issue #17).
  it('reports unknown, never none, when the lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(429, {}, { 'retry-after': '3' })));
    expect(await lookupOrder('alice')).toEqual({ status: 'unknown', retryAfterMs: 3000 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(503, {})));
    expect(await lookupOrder('alice')).toEqual({ status: 'unknown' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    expect(await lookupOrder('alice')).toEqual({ status: 'unknown' });
  });
});

describe('lookupOrderUntilKnown', () => {
  const quick = { firstMs: 1, maxMs: 2 };

  it('retries a failed lookup until it answers', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(answer(429, {}))
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(answer(200, [{ orderId: 'o1' }]));
    vi.stubGlobal('fetch', fetch);

    const lookup = await lookupOrderUntilKnown('alice', new AbortController().signal, quick);

    expect(lookup).toEqual({ status: 'held', orderId: 'o1' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up quietly once aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(503, {})));
    const abort = new AbortController();

    const lookup = lookupOrderUntilKnown('alice', abort.signal, { firstMs: 60_000, maxMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();

    expect(await lookup).toBeUndefined();
  });
});
