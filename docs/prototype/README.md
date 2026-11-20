# Spike: verifying the atomic grant

Throwaway code that exists to de-risk [the plan](../PLAN.md) §4, not to be the implementation. It proves the Lua grant script is correct before any of the surrounding system gets built. `grant.lua` graduates into `packages/core/` as-is; `verify.mjs` gets replaced by the Vitest integration suite and deleted.

`verify.mjs` speaks RESP over raw sockets deliberately — no dependencies, so it runs against nothing but a Redis and a Node binary, and there is no client library sitting between the assertions and the engine.

## Running it

```sh
redis-server --port 6399 --save '' --daemonize yes
node verify.mjs
redis-cli -p 6399 shutdown nosave
```

It uses its own port and deletes its keys, so it will not touch a Redis you already have on 6379.

## What it asserts

- **No oversell** — stock 1000 against 20 000 distinct users over 50 concurrent pipelined connections: exactly 1000 confirmed, and stock/buyers-set/stream all agree.
- **No double-grant** — 1000 concurrent attempts from a single user: exactly one order, stock down by exactly one.
- **Window boundaries** — before start and after end are rejected with no stock consumed.
- **Unconfigured sale** — a missing window hash fails closed rather than throwing.
- **No sticky losers** — users who hit a sold-out sale are not left in the buyers set, so a restock does not permanently lock them out.

## Last run

Redis 8.0.3, all checks passed. 20 000 grants in 95 ms — **~210 000 ops/s** on a single unoptimised local instance.

The headline number is not the point; the ratio is. The grant decision is ~20× cheaper than the system's 10k/s target, which says the bottleneck lives in the HTTP tier and not in the serialization point, and that the scaling work belongs there.
