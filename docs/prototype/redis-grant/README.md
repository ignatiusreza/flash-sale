# Spike: the Redis grant — evaluated, not adopted

**This is not the chosen design.** It is the alternative costed first, kept because the measurement is what justifies rejecting it, and because it is the basis of the optional admission filter in [plan](../../PLAN.md) §15.

The idea: make the grant decision synchronously in a single atomic Redis Lua script — window check, per-user dedupe, stock decrement and an `XADD` to a Redis Stream, all as one indivisible unit — and have a worker drain the stream into Postgres afterwards.

`verify.mjs` speaks RESP over raw sockets deliberately — no dependencies, so it runs against nothing but a Redis and a Node binary.

## Running it

```sh
redis-server --port 6399 --save '' --daemonize yes
node verify.mjs
redis-cli -p 6399 shutdown nosave
```

It uses its own port and deletes its keys, so it will not touch a Redis you already have on 6379.

## What it asserts

All checks pass against Redis 8.0.3:

- **No oversell** — stock 1000 against 20 000 distinct users over 50 concurrent pipelined connections: exactly 1000 confirmed.
- **No double-grant** — 1000 concurrent attempts from a single user: exactly one order.
- **Window boundaries** — before start and after end rejected, no stock consumed.
- **Unconfigured sale** — a missing window hash fails closed rather than throwing.
- **No sticky losers** — users who hit a sold-out sale are not left in the buyers set, so a restock does not permanently lock them out.

Throughput: **20 000 grants in 92 ms — ~210 000 ops/s** on a single unoptimised local instance.

## Why it was rejected anyway

It is roughly 9× faster than the chosen design's batched worker (~210k/s vs ~23.6k/s), and it answers every request synchronously in about a millisecond regardless of queue depth. Those are real advantages and the plan does not pretend otherwise.

It loses on correctness. The grant lives in Redis before it reaches Postgres, so there is a window — bounded by `appendfsync everysec` — in which a user has been told "confirmed" while no durable order exists. A crash in that window means the system lied. The chosen design publishes a result only *after* the transaction commits, so its answers and its durable state can never disagree.

Two secondary costs reinforced the decision:

- **Two systems, no transaction between them.** Grant in Redis, persist via the stream — the `XADD` being inside the Lua script is what keeps those atomic, which works, but it means the pending-persistence queue shares a failure domain with the decision itself. One Redis outage takes out both.
- **An extra component.** Redis would be a third piece of infrastructure alongside RabbitMQ and Postgres. Since the queue can own the decision outright, it is not needed at all.

## Where it may yet come back

Plan §15 keeps it as the second scaling route: placed *ahead* of RabbitMQ purely as an admission filter, it would reject losers in sub-millisecond time while winners still flow through the authoritative transaction. In that role the correctness objection disappears, because the Redis decision would be provisional rather than final. Worth doing only if the stress numbers demand it.
