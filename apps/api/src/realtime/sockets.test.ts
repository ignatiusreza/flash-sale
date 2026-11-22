import { describe, expect, it, vi } from 'vitest';

import { SocketRegistry } from './sockets.js';

function socket() {
  return { emit: vi.fn() };
}

describe('SocketRegistry', () => {
  it('delivers only to the named user', () => {
    const registry = new SocketRegistry();
    const alice = socket();
    const bob = socket();
    registry.add('alice', alice);
    registry.add('bob', bob);

    expect(registry.deliver('alice', 'purchase:result', { ok: true })).toBe(1);

    expect(alice.emit).toHaveBeenCalledWith('purchase:result', { ok: true });
    expect(bob.emit).not.toHaveBeenCalled();
  });

  it('reports zero when the user is on another instance', () => {
    // Every instance sees every result; this is the discard path, and it must
    // be silent rather than an error (docs/PLAN.md §8).
    const registry = new SocketRegistry();

    expect(registry.deliver('elsewhere', 'purchase:result', {})).toBe(0);
  });

  it('delivers to every tab a user has open', () => {
    const registry = new SocketRegistry();
    const tabs = [socket(), socket(), socket()];
    for (const tab of tabs) registry.add('alice', tab);

    expect(registry.deliver('alice', 'purchase:result', { id: 1 })).toBe(3);
    for (const tab of tabs) expect(tab.emit).toHaveBeenCalledOnce();
  });

  it('keeps the remaining tabs when one disconnects', () => {
    const registry = new SocketRegistry();
    const first = socket();
    const second = socket();
    registry.add('alice', first);
    registry.add('alice', second);

    registry.remove('alice', first);

    expect(registry.deliver('alice', 'e', {})).toBe(1);
    expect(second.emit).toHaveBeenCalledOnce();
  });

  it('forgets a user once their last socket goes, rather than leaking a key each', () => {
    const registry = new SocketRegistry();
    for (let i = 0; i < 500; i++) {
      const only = socket();
      registry.add(`user-${i}`, only);
      registry.remove(`user-${i}`, only);
    }

    expect(registry.users).toBe(0);
    expect(registry.connections).toBe(0);
  });

  it('counts sockets rather than users', () => {
    const registry = new SocketRegistry();
    registry.add('alice', socket());
    registry.add('alice', socket());
    registry.add('bob', socket());

    expect(registry.connections).toBe(3);
    expect(registry.users).toBe(2);
  });

  it('tolerates removing a socket that was never added', () => {
    const registry = new SocketRegistry();

    expect(() => registry.remove('ghost', socket())).not.toThrow();
  });
});
