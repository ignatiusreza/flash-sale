import { describe, expect, it } from 'vitest';

import { ATTEMPTS_QUEUE, EVENTS_EXCHANGE } from './contracts.js';
import { topologyNames } from './topology.js';

describe('topologyNames', () => {
  const plain = { queue: ATTEMPTS_QUEUE, exchange: EVENTS_EXCHANGE };

  // A deployed broker must keep the names it has.
  it('keeps the plain names in production, or with no environment set', () => {
    expect(topologyNames('production')).toEqual(plain);
    expect(topologyNames()).toEqual(plain);
    expect(topologyNames('')).toEqual(plain);
  });

  it('prefixes both names per environment, so environments on one broker never meet', () => {
    expect(topologyNames('development')).toEqual({
      queue: 'development.purchase.attempts',
      exchange: 'development.flash-sale.events',
    });
    expect(topologyNames('e2e').queue).not.toEqual(topologyNames('development').queue);
  });

  it('refuses an environment that would make a confusing name', () => {
    expect(() => topologyNames('Dev')).toThrow(/invalid APP_ENV/);
    expect(() => topologyNames('a.b')).toThrow(/invalid APP_ENV/);
    expect(() => topologyNames('-x')).toThrow(/invalid APP_ENV/);
  });
});
