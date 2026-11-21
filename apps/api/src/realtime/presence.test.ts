import { describe, expect, it } from 'vitest';

import { PresenceTracker } from './presence.js';

const NOW = 1_000_000;

describe('PresenceTracker', () => {
  it('sums what every instance announced', () => {
    const tracker = new PresenceTracker(15_000);
    tracker.record('a', 3, NOW);
    tracker.record('b', 4, NOW);

    expect(tracker.total(NOW)).toBe(7);
  });

  it('replaces an instance count rather than accumulating it', () => {
    // Each announcement is the instance's current count, not a delta — adding
    // them would make the viewer number climb for ever.
    const tracker = new PresenceTracker(15_000);
    tracker.record('a', 10, NOW);
    tracker.record('a', 2, NOW + 1_000);

    expect(tracker.total(NOW + 1_000)).toBe(2);
  });

  it('expires an instance that stopped announcing', () => {
    // A crashed instance must not keep contributing viewers indefinitely.
    const tracker = new PresenceTracker(15_000);
    tracker.record('alive', 2, NOW);
    tracker.record('crashed', 100, NOW);

    const later = NOW + 20_000;
    tracker.record('alive', 2, later);

    expect(tracker.total(later)).toBe(2);
    expect(tracker.instances).toBe(1);
  });

  it('counts an instance right up to the staleness boundary', () => {
    const tracker = new PresenceTracker(15_000);
    tracker.record('a', 5, NOW);

    expect(tracker.total(NOW + 14_999)).toBe(5);
    expect(tracker.total(NOW + 15_000)).toBe(0);
  });

  it('is zero before anything has been heard', () => {
    expect(new PresenceTracker(15_000).total(NOW)).toBe(0);
  });
});
