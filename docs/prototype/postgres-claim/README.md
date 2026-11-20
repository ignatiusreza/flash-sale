# Spike: the conditional claim, measured

Throwaway code that exists to de-risk [the plan](../../PLAN.md) §4, not to be the implementation. It establishes three things before any of the surrounding system gets built: that the claim cannot oversell, that a redelivered batch is a no-op, and what a single serial worker can actually sustain.

Driven with `psql` and `pgbench` rather than application code deliberately — no client library, no ORM and no worker loop sitting between the assertions and the engine.

## Running it

```sh
initdb -D ./pgdata -U postgres --auth=trust
pg_ctl -D ./pgdata -o "-p 5499" -l pg.log start
psql -p 5499 -U postgres -f schema.sql

# correctness: batch semantics, fairness, idempotent redelivery
psql -p 5499 -U postgres -f batch_test.sql

# correctness: 20 000 attempts against stock of 1000
psql -p 5499 -U postgres -c "TRUNCATE orders; ALTER SEQUENCE user_seq RESTART; UPDATE sales SET total_stock=1000, remaining=1000;"
pgbench -p 5499 -U postgres -n -c 50 -j 4 -t 400 -f claim_safe.sql postgres
psql -p 5499 -U postgres -c "SELECT count(*) FROM orders;"   -- must be exactly 1000

# throughput: unbatched, multi-statement batch, single-statement batch
psql -p 5499 -U postgres -c "TRUNCATE orders; ALTER SEQUENCE user_seq RESTART; UPDATE sales SET remaining=100000000;"
pgbench -p 5499 -U postgres -n -c 1 -j 1 -T 10 -f claim_single.sql postgres
pgbench -p 5499 -U postgres -n -c 1 -j 1 -T 10 -f claim_batch.sql postgres
pgbench -p 5499 -U postgres -n -c 1 -j 1 -T 10 -f claim_batch_guarded.sql postgres   # needs batch_test.sql run first

pg_ctl -D ./pgdata stop
```

It runs on its own port and its own cluster, so it will not touch a Postgres you already have.

## The files

| File | What it is |
|---|---|
| `schema.sql` | `sales` + `orders` per plan §9, including the `CHECK (remaining >= 0)` and `UNIQUE (sale_id, user_id)` backstops |
| `claim_safe.sql` | The single claim. One CTE: the order is inserted only if the `UPDATE` actually took a unit |
| `batch_test.sql` | **The real batch claim**, as a function, plus seven correctness cases |
| `claim_batch_guarded.sql` | Throughput probe for the batch function |
| `claim_single.sql` | Throughput probe, one claim per transaction |
| `claim_batch.sql` | Throughput probe, 100 claims in a multi-statement transaction |

`claim_single.sql` and `claim_batch.sql` are *measurement* scripts only. They deliberately do not guard the insert on the update, because they exist to time the write path at a known stock level — do not copy them into the worker. `claim_safe.sql` and the function in `batch_test.sql` are what ships.

## Correctness results

`batch_test.sql`, all passing:

| Case | Expected | Result |
|---|---|---|
| Batch of 100, stock 1000 | 100 granted, 900 remaining | ✅ |
| Batch of 100, stock 5 | 5 granted, 0 remaining | ✅ |
| Same batch, by arrival order | first five win | ✅ `b001…b005` |
| **Redelivery of a committed batch** | 0 granted, stock unchanged, no new orders | ✅ idempotent |
| Same user three times in one batch | 1 granted, 1 unit consumed | ✅ |
| Batch against stock 0 | 0 granted | ✅ |
| Two batches straddling sellout | `orders = total_stock - remaining` | ✅ 50 orders, 0 remaining |

Plus, via `pgbench`: **20 000 attempts across 50 connections against stock of 1000 produced exactly 1000 orders, 1000 distinct users, `remaining` = 0, 0 failed transactions.**

The redelivery case is the one worth dwelling on. The batch decrements stock by the number of rows *actually inserted* rather than by the batch size, so replaying a committed batch grants nothing and consumes nothing. The obvious alternative — decrementing by `array_length()` — passes every test above except that one, and would silently destroy stock on every redelivery. RabbitMQ delivery is at-least-once, so this is not hypothetical.

## Throughput results

PostgreSQL 18.6, default config (`synchronous_commit=on`), single local machine.

| Scenario | Config | Result |
|---|---|---|
| Serial worker, unbatched | `-c 1`, 1 claim/txn | 835 claims/s, 1.2 ms mean |
| Serial worker, multi-statement batch | `-c 1`, 100 claims/txn | ~23 650 claims/s, 4.2 ms |
| Serial worker, **single-statement batch** | `-c 1`, 100 claims/stmt | **~37 000–41 500 claims/s**, 2.4–2.7 ms |
| Contended, many writers | `-c 50`, stock plentiful | 899 claims/s, **55.6 ms mean** |
| Post-sellout rejections | `-c 50`, stock 0 | ~17k/s even while reaching Postgres |

## What the numbers mean

**Batching is the design, not an optimisation.** Unbatched, a serial worker manages 835 claims/s and misses the 10k/s target by more than an order of magnitude. Batched, it clears it ~4×, because the cost is the fsync per commit and amortising that commit is where all the throughput lives.

**Round trips cost about as much as the work.** The only difference between the two batch rows is `BEGIN / UPDATE / INSERT / COMMIT` as four messages versus one statement doing identical work — worth ~1.6×. At this granularity the network dominates, which is why the shipped form is a single statement rather than a transaction block.

**The lock convoy is real, and measured.** Going from 1 connection to 50 competing for the same stock row raised throughput 7% and mean latency 46×. That is the clearest argument for serializing upstream in the queue rather than letting API instances contend at the database, and it is why plan §3 rejects the obvious `UPDATE ... WHERE remaining > 0`-per-request design.

**The expensive path is bounded by stock, not traffic.** Only winners cost a write, and there are at most `totalStock` of them. Losers after sellout sustained ~17k/s *while still hitting Postgres* — and plan §6 rejects them in memory at the API layer, so they never get this far.
