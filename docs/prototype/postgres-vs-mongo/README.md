# Spike: PostgreSQL or MongoDB?

Both engines run the **same** model — stock pre-warmed as N claimable rows or documents, claimed one at a time — through **equivalent Node clients**, so neither side gets a native-tool advantage the way `pgbench` would have given Postgres. Both over TCP, Mongo on host networking so Docker NAT is not in the path.

**Verdict: Postgres, and not narrowly.** It is faster, it is the only one of the two that can have both fairness and throughput, and it does not force a data model.

## Running it

```sh
# Postgres on TCP
initdb -D ./pgdata -U postgres --auth=trust
pg_ctl -D ./pgdata -o "-p 5499" -l pg.log start

# Mongo as a single-node replica set (transactions need one; the pool model does not)
docker run -d --name fs-mongo --network host mongo:8 --replSet rs0 --port 27019 --bind_ip_all
docker exec fs-mongo mongosh --port 27019 --quiet \
  --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27019"}]})'

npm install pg mongodb
node bench.mjs correctness
CONC=50 DUR=10000 node bench.mjs throughput
MONGO_SORT=0 CONC=50 DUR=10000 node bench.mjs throughput
```

## Correctness

20 000 concurrent attempts against 1000 slots. **Both pass**, with or without the sort:

| Engine | Claims reported | Slots filled | Distinct users |
|---|---|---|---|
| postgres | 1000 | 1000 | 1000 |
| mongodb | 1000 | 1000 | 1000 |

Worth noting in Mongo's favour: `findOneAndUpdate` applies its predicate at update time, so **the obvious MongoDB code is correct**. The obvious Postgres code is not — [`../postgres-pool/`](../postgres-pool/) shows `UPDATE … WHERE id = (SELECT … LIMIT 1)` overselling 9.5× via lost update. Postgres needs `FOR UPDATE SKIP LOCKED` to be safe here; Mongo needs nothing. That is a genuine ergonomic win and it is the only category Mongo takes outright.

## Throughput

Concurrency 50, 400k-slot pool, several runs each.

| Engine | Claims/s | p50 | p99 |
|---|---|---|---|
| postgres (`SKIP LOCKED`, ordered) | **4 500 – 10 900** | 3–5 ms | 18–29 ms |
| mongodb (ordered, `sort: {_id:1}`) | 1 400 – 1 700 | ~23 ms | 114–181 ms |
| mongodb (unordered, no sort) | ~3 200 | ~16 ms | 38–47 ms |

Postgres is roughly **3–7× faster when both preserve ordering**, and still ~2–3× faster when Mongo gives ordering up. Postgres was also the more *variable* of the two — Mongo's numbers were remarkably stable run to run, while Postgres swung between 4.5k and 10.9k, most likely checkpoint activity on a busy machine. Mongo is slower but more predictable, which is worth knowing even though it does not change the conclusion.

## The three findings that actually decide it

**1. No `SKIP LOCKED` equivalent, so Mongo must choose between fairness and throughput.**

This is the sharpest difference. With `sort: {_id: 1}`, every concurrent claimant targets the *same* lowest free document; MongoDB resolves the write conflict by retrying the same query, so they serialise into a convoy — hence the 114–181 ms p99. Dropping the sort doubles throughput and cuts p99 by 3–4×, but surrenders arrival order.

Arrival order is not a nicety here: plan §4.1 allocates by ordinal specifically so that when a batch straddles sellout the earliest arrivals win, which is how the brief's fairness requirement is implemented. `FOR UPDATE SKIP LOCKED` gives Postgres both — claimants step over locked rows instead of queueing behind them. In MongoDB you pick one.

**2. The atomicity unit dictates the data model.**

Postgres's atomic unit is the statement, so "decrement the counter **and** insert the order" is one CTE (§4). MongoDB's atomic unit is the document, so that same operation spans two documents and requires a multi-document transaction — which needs a replica set and carries real overhead.

The pool model is the only design both engines express natively, because it puts each unit of stock in its own document. So **choosing MongoDB settles open question 5 by fiat rather than on merit** — it removes the counter design from the menu. That may be fine, but a database should not be making that call.

**3. Unique indexes treat `null` differently, and it bites immediately.**

Postgres treats NULLs as mutually distinct in a unique index, so a thousand unclaimed slots coexist happily under `UNIQUE (sale_id, user_id)` with no special handling. MongoDB treats `null` as a value, so a plain unique index rejects every free slot after the first. The first run of this spike failed outright on a duplicate key.

The fix is a partial index:

```js
col.createIndex({ userId: 1 }, {
  unique: true,
  partialFilterExpression: { userId: { $type: 'string' } },
});
```

Small, but it is the sort of thing that is discovered in production by whoever did not read this file.

## Where MongoDB would genuinely win

Not here, but worth being able to say where:

- **Change streams could replace the results fanout.** API instances could tail the `orders` collection directly instead of consuming a RabbitMQ fanout (§8). That is a real simplification and the most interesting thing MongoDB offers this design.
- **Rich, variable order documents.** If an order grew per-campaign attributes and nested fulfilment state, the document model would start paying for itself. For `{id, sale_id, user_id, created_at}` it earns nothing.
- **Horizontal write sharding** beyond a single primary. At 1000 units this is not a problem anyone has.

## A licensing dimension the benchmark does not show

Worth stating because `CLAUDE.md` forbids copyleft dependencies, and the measurement above is silent on it.

PostgreSQL ships under the PostgreSQL Licence, which is permissive and BSD-like. MongoDB's **server** moved to the SSPL, which is aggressively copyleft for anyone offering the software as a service and is not OSI-approved. The **Node driver** (`mongodb`) is Apache-2.0, so the dependency allowlist would not flag it — the obligation attaches to running and especially to distributing the server, not to the client library.

For a self-hosted take-home this changes nothing. For a product it is a question someone in legal has to answer, and it is a cost that only appears after the engine is already load-bearing. It is not the reason to pick Postgres, but it is one more thing Postgres does not ask of you.

## Why Postgres wins for this workload

The shape of the problem is a small amount of highly-contended data with hard invariants and a fixed schema. Every Postgres strength applies directly — transactional multi-row writes, `CHECK` and `UNIQUE` as independent durable enforcers the application cannot bypass, `SKIP LOCKED` for contention, and ordinary SQL for reporting afterwards. None of MongoDB's strengths do: there is no schema flexibility to exploit, no document-shaped aggregate, and nothing to shard.

Choosing MongoDB here would mean accepting a 3–7× throughput cost, giving up either fairness or that throughput, and letting the database choose the inventory model — in exchange for advantages this workload cannot use.
