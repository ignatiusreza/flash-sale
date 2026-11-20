# Spike: the conditional claim, measured

Throwaway code that exists to de-risk [the plan](../../PLAN.md) §4, not to be the implementation. It establishes two things before any of the surrounding system gets built: that the claim statement cannot oversell, and what a single serial worker can actually sustain.

Driven with `pgbench` rather than application code deliberately — no client library, no ORM and no worker loop sitting between the assertions and the engine.

## Running it

```sh
initdb -D ./pgdata -U postgres --auth=trust
pg_ctl -D ./pgdata -o "-p 5499" -l pg.log start
psql -p 5499 -U postgres -f schema.sql

# correctness: 20 000 attempts against stock of 1000
psql -p 5499 -U postgres -c "TRUNCATE orders; ALTER SEQUENCE user_seq RESTART; UPDATE sales SET total_stock=1000, remaining=1000;"
pgbench -p 5499 -U postgres -n -c 50 -j 4 -t 400 -f claim_safe.sql postgres
psql -p 5499 -U postgres -c "SELECT count(*) FROM orders;"   -- must be exactly 1000

# throughput: the serial worker, unbatched then batched
psql -p 5499 -U postgres -c "TRUNCATE orders; ALTER SEQUENCE user_seq RESTART; UPDATE sales SET remaining=100000000;"
pgbench -p 5499 -U postgres -n -c 1 -j 1 -T 10 -f claim_single.sql postgres
pgbench -p 5499 -U postgres -n -c 1 -j 1 -T 10 -f claim_batch.sql postgres

pg_ctl -D ./pgdata stop
```

It runs on its own port and its own cluster, so it will not touch a Postgres you already have.

## The files

| File | What it is |
|---|---|
| `schema.sql` | `sales` + `orders` per plan §9, including the `CHECK (remaining >= 0)` and `UNIQUE (sale_id, user_id)` backstops |
| `claim_safe.sql` | **The real claim.** One CTE: the order is inserted only if the `UPDATE` actually took a unit |
| `claim_single.sql` | Throughput probe, one claim per transaction |
| `claim_batch.sql` | Throughput probe, 100 claims per transaction |

`claim_single.sql` and `claim_batch.sql` are *measurement* scripts only. They deliberately do not guard the insert on the update, because they exist to time the write path at a known stock level — do not copy them into the worker. `claim_safe.sql` is the statement that ships.

## Results

PostgreSQL 18.6, default config (`synchronous_commit=on`), single local machine.

| Scenario | Config | Result |
|---|---|---|
| **No oversell** | 20 000 attempts, 50 connections, stock 1000 | **exactly 1000 orders, 1000 distinct users, `remaining` = 0, 0 failed transactions** |
| Serial worker, unbatched | `-c 1`, 1 claim/txn | 835 claims/s, 1.2 ms mean |
| Serial worker, batched | `-c 1`, 100 claims/txn | **~23 650 claims/s** (236.5 tps × 100), 4.2 ms per batch |
| Contended, many writers | `-c 50`, stock plentiful | 899 claims/s, **55.6 ms mean** |
| Post-sellout rejections | `-c 50`, stock 0 | ~17k/s even while reaching Postgres |

## What the numbers mean

**Batching is the design, not an optimisation.** Unbatched, a serial worker manages 835 claims/s and misses the 10k/s target by more than an order of magnitude. Batching 100 claims into one transaction clears it 2.4× — a 28× improvement — because the cost is the fsync per commit, and amortising that commit is where all the throughput lives.

**The lock convoy is real, and measured.** Going from 1 connection to 50 competing for the same stock row raised throughput by 7% and mean latency by 46×. That is the single clearest argument for serializing upstream in the queue rather than letting API instances contend at the database, and it is why plan §3 rejects the obvious `UPDATE ... WHERE remaining > 0`-per-request design.

**The expensive path is bounded by stock, not traffic.** Only winners cost a write, and there are at most `totalStock` of them. Losers after sellout sustained ~17k/s *while still hitting Postgres* — and plan §6 rejects them in memory at the API layer instead, so they never get this far.
